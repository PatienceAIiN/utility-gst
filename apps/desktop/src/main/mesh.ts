import { app } from 'electron'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces, hostname } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { history } from './history'

/**
 * Intranet mesh: discover other Utility installations on the same office
 * network and share register data with explicit, revocable permission.
 *
 * This deliberately serves client financial data over a LAN, so the threat model
 * is taken seriously rather than assuming "the office network is safe":
 *
 *  - OFF by default. Nothing listens and nothing broadcasts until switched on.
 *  - Bound to private address ranges only. A request arriving from a public
 *    address is refused outright, so a misconfigured router cannot expose it.
 *  - Pairing requires a 6-digit code displayed on BOTH devices and confirmed on
 *    the receiving one. A peer cannot pair silently by knowing an address.
 *  - Permissions default to NONE. View, read and write are granted one at a
 *    time and can be revoked, taking effect immediately.
 *  - Every request is HMAC-signed with the per-peer secret established during
 *    pairing, with a timestamp window to stop replay. Discovering the port is
 *    not enough to read anything.
 *  - Invoices themselves are never served. Only register summaries, and only
 *    with an explicit grant.
 */

const DISCOVERY_PORT = 45892
const ANNOUNCE_INTERVAL_MS = 5000
const PEER_STALE_MS = 20000
const SIGNATURE_WINDOW_MS = 60_000

export type Permission = 'view' | 'read' | 'write'

export interface Peer {
  deviceId: string
  name: string
  address: string
  port: number
  lastSeen: string
  paired: boolean
  /** What THIS device allows the peer to do. */
  grants: Permission[]
}

interface PairedRecord {
  deviceId: string
  name: string
  secret: string
  grants: Permission[]
  pairedAt: string
}

export interface PairRequest {
  deviceId: string
  name: string
  address: string
  code: string
  at: string
}

interface MeshState {
  enabled: boolean
  deviceId: string
  deviceName: string
  paired: Record<string, PairedRecord>
}

const isPrivateAddress = (address: string): boolean =>
  /^10\./.test(address) ||
  /^192\.168\./.test(address) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
  /^169\.254\./.test(address) ||
  address === '127.0.0.1'

function localAddresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
        found.push(entry.address)
      }
    }
  }
  return found
}

class Mesh {
  private path = join(app.getPath('userData'), 'mesh.json')
  private state: MeshState | null = null
  private server: Server | null = null
  private socket: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private port = 0
  private seen = new Map<string, Peer>()
  private pending = new Map<string, PairRequest & { secret: string }>()
  /** Codes this device is currently offering to a peer it asked to pair with. */
  private outgoing = new Map<string, { code: string; secret: string }>()

  private load(): MeshState {
    if (this.state) return this.state
    try {
      if (existsSync(this.path)) {
        this.state = JSON.parse(readFileSync(this.path, 'utf8')) as MeshState
        return this.state
      }
    } catch {
      console.error('[mesh] state unreadable')
    }
    this.state = {
      enabled: false,
      deviceId: randomUUID(),
      deviceName: hostname() || 'Utility device',
      paired: {}
    }
    this.persist()
    return this.state
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      console.error('[mesh] state write failed', error)
    }
  }

  // --- request signing ----------------------------------------------------

  private sign(secret: string, method: string, path: string, timestamp: string, body: string): string {
    return createHmac('sha256', secret).update(`${method}\n${path}\n${timestamp}\n${body}`).digest('hex')
  }

  private verify(request: IncomingMessage, path: string, body: string): PairedRecord | null {
    const state = this.load()
    const deviceId = String(request.headers['x-utility-device'] ?? '')
    const timestamp = String(request.headers['x-utility-timestamp'] ?? '')
    const signature = String(request.headers['x-utility-signature'] ?? '')
    const record = state.paired[deviceId]
    if (!record || !timestamp || !signature) return null

    // Replay window. A signature captured yesterday must not work today.
    const age = Math.abs(Date.now() - Number(timestamp))
    if (!Number.isFinite(age) || age > SIGNATURE_WINDOW_MS) return null

    const expected = this.sign(record.secret, request.method ?? 'GET', path, timestamp, body)
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return record
  }

  // --- HTTP surface -------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown): void => {
      const text = JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }

    const remote = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    // Refuse anything that is not on a private network, regardless of routing.
    if (!isPrivateAddress(remote)) return send(403, { error: 'Refused: not a local network address.' })

    const url = new URL(request.url ?? '/', 'http://local')
    const path = url.pathname
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const state = this.load()

    // Unauthenticated: identity only. Reveals a name, never data.
    if (path === '/mesh/hello') {
      return send(200, { deviceId: state.deviceId, name: state.deviceName })
    }

    // Unauthenticated: a pair REQUEST. Creates a prompt on this device; it does
    // not grant anything by itself.
    if (path === '/mesh/pair/request' && request.method === 'POST') {
      let parsed: { deviceId?: string; name?: string; code?: string; secret?: string }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        return send(400, { error: 'Bad request.' })
      }
      if (!parsed.deviceId || !parsed.code || !parsed.secret) return send(400, { error: 'Bad request.' })
      this.pending.set(parsed.deviceId, {
        deviceId: parsed.deviceId,
        name: String(parsed.name ?? 'Unknown device').slice(0, 80),
        address: remote,
        code: String(parsed.code).slice(0, 8),
        secret: String(parsed.secret).slice(0, 128),
        at: new Date().toISOString()
      })
      return send(202, { pending: true })
    }

    // Confirmation that the far side approved an offer WE sent. Proof is an
    // HMAC over the secret we generated, which only a device that received our
    // offer can produce -- so this cannot be forged by anything that merely
    // discovered our address.
    if (path === '/mesh/pair/confirm' && request.method === 'POST') {
      let parsed: { deviceId?: string; name?: string; proof?: string }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        return send(400, { error: 'Bad request.' })
      }
      const offer = parsed.deviceId ? this.outgoing.get(parsed.deviceId) : undefined
      if (!offer || !parsed.proof) return send(401, { error: 'No pending offer.' })
      const expected = createHmac('sha256', offer.secret)
        .update(`confirm:${parsed.deviceId}`)
        .digest('hex')
      const a = Buffer.from(expected)
      const b = Buffer.from(parsed.proof)
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return send(401, { error: 'Bad proof.' })
      }
      this.confirmOutgoing(parsed.deviceId!, String(parsed.name ?? 'Utility device').slice(0, 80))
      return send(200, { ok: true })
    }

    // Everything below requires a paired, signed request.
    const record = this.verify(request, path, body)
    if (!record) return send(401, { error: 'Not paired, or signature invalid.' })

    if (path === '/mesh/summary') {
      if (!record.grants.includes('view')) return send(403, { error: 'No permission.' })
      const page = history.list({ page: 1, pageSize: 200 })
      return send(200, {
        device: state.deviceName,
        count: page.total,
        // Deliberately coarse: names and totals only, no line items, no GSTINs.
        items: page.items.map((r) => ({
          id: r.id,
          invoiceNo: r.invoiceNo,
          invoiceDate: r.invoiceDate,
          rows: r.rows,
          blocked: r.blocked
        }))
      })
    }

    if (path === '/mesh/record') {
      if (!record.grants.includes('read')) return send(403, { error: 'No permission.' })
      const id = url.searchParams.get('id') ?? ''
      const found = history.get(id)
      if (!found) return send(404, { error: 'Not found.' })
      return send(200, found)
    }

    if (path === '/mesh/push' && request.method === 'POST') {
      if (!record.grants.includes('write')) return send(403, { error: 'No permission.' })
      try {
        const incoming = JSON.parse(body) as Record<string, unknown>
        history.add({
          sourceFile: String(incoming['sourceFile'] ?? 'shared'),
          sha256: String(incoming['sha256'] ?? ''),
          invoiceNo: (incoming['invoiceNo'] as string) ?? null,
          invoiceDate: (incoming['invoiceDate'] as string) ?? null,
          party: (incoming['party'] as string) ?? null,
          gstin: (incoming['gstin'] as string) ?? null,
          supplyType: (incoming['supplyType'] as string) ?? null,
          rows: Number(incoming['rows'] ?? 0),
          taxable: (incoming['taxable'] as string) ?? null,
          taxTotal: (incoming['taxTotal'] as string) ?? null,
          grandTotal: (incoming['grandTotal'] as string) ?? null,
          tieOutDelta: (incoming['tieOutDelta'] as string) ?? null,
          blocked: Boolean(incoming['blocked']),
          warnings: [`shared by ${record.name}`],
          note: `Received from ${record.name} over the local network.`
        })
        return send(200, { ok: true })
      } catch {
        return send(400, { error: 'Bad payload.' })
      }
    }

    return send(404, { error: 'Unknown endpoint.' })
  }

  // --- discovery ----------------------------------------------------------

  private startDiscovery(): void {
    const state = this.load()
    this.socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (message, remote) => {
      if (!isPrivateAddress(remote.address)) return
      try {
        const announced = JSON.parse(message.toString('utf8')) as {
          deviceId: string
          name: string
          port: number
        }
        if (!announced.deviceId || announced.deviceId === state.deviceId) return
        const known = state.paired[announced.deviceId]
        this.seen.set(announced.deviceId, {
          deviceId: announced.deviceId,
          name: String(announced.name ?? 'Utility device').slice(0, 80),
          address: remote.address,
          port: Number(announced.port) || 0,
          lastSeen: new Date().toISOString(),
          paired: Boolean(known),
          grants: known?.grants ?? []
        })
      } catch {
        /* ignore malformed announcements */
      }
    })
    this.socket.bind(DISCOVERY_PORT, () => {
      this.socket?.setBroadcast(true)
      this.announce()
      this.timer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS)
    })
  }

  private announce(): void {
    const state = this.load()
    const payload = Buffer.from(
      JSON.stringify({ deviceId: state.deviceId, name: state.deviceName, port: this.port })
    )
    for (const address of localAddresses()) {
      const broadcast = address.replace(/\.\d+$/, '.255')
      try {
        this.socket?.send(payload, DISCOVERY_PORT, broadcast)
      } catch {
        /* interface may have gone away */
      }
    }
  }

  // --- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.server) return
    const state = this.load()
    state.enabled = true
    this.persist()

    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '0.0.0.0', () => {
        const address = this.server!.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
    this.startDiscovery()
  }

  stop(): void {
    const state = this.load()
    state.enabled = false
    this.persist()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
    this.server?.close()
    this.server = null
    this.seen.clear()
    this.pending.clear()
  }

  status(): {
    enabled: boolean
    deviceId: string
    deviceName: string
    port: number
    addresses: string[]
    peers: Peer[]
    requests: PairRequest[]
  } {
    const state = this.load()
    const cutoff = Date.now() - PEER_STALE_MS
    const peers = [...this.seen.values()].filter((p) => new Date(p.lastSeen).getTime() > cutoff)
    // Include paired devices that are currently offline so grants stay visible.
    for (const record of Object.values(state.paired)) {
      if (!peers.some((p) => p.deviceId === record.deviceId)) {
        peers.push({
          deviceId: record.deviceId,
          name: record.name,
          address: '',
          port: 0,
          lastSeen: record.pairedAt,
          paired: true,
          grants: record.grants
        })
      }
    }
    return {
      enabled: state.enabled && this.server !== null,
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      port: this.port,
      addresses: localAddresses(),
      peers,
      requests: [...this.pending.values()].map(({ secret: _secret, ...rest }) => rest)
    }
  }

  setDeviceName(name: string): void {
    const state = this.load()
    state.deviceName = name.trim().slice(0, 80) || hostname()
    this.persist()
  }

  /** Ask a peer to pair. Returns the code the OTHER device must show. */
  async requestPair(deviceId: string): Promise<{ ok: boolean; code?: string; error?: string }> {
    const peer = this.seen.get(deviceId)
    if (!peer || !peer.port) return { ok: false, error: 'That device is not reachable.' }
    const state = this.load()
    const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0')
    const secret = randomBytes(32).toString('hex')
    this.outgoing.set(deviceId, { code, secret })
    try {
      const response = await fetch(`http://${peer.address}:${peer.port}/mesh/pair/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: state.deviceId, name: state.deviceName, code, secret }),
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) return { ok: false, error: `Device refused (${response.status}).` }
      return { ok: true, code }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not reach device.' }
    }
  }

  /** Approve a pending request AFTER the operator has matched the code. */
  private async notifyApproved(deviceId: string, secret: string): Promise<void> {
    const peer = this.seen.get(deviceId)
    if (!peer || !peer.port) return
    const state = this.load()
    const proof = createHmac('sha256', secret).update(`confirm:${state.deviceId}`).digest('hex')
    try {
      await fetch(`http://${peer.address}:${peer.port}/mesh/pair/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: state.deviceId, name: state.deviceName, proof }),
        signal: AbortSignal.timeout(8000)
      })
    } catch {
      // Best effort. If it does not land, the requester can retry Connect;
      // an approval that is not delivered must not leave THIS side broken.
    }
  }

  approvePair(deviceId: string, code: string): { ok: boolean; error?: string } {
    const request = this.pending.get(deviceId)
    if (!request) return { ok: false, error: 'No pending request from that device.' }
    if (request.code !== code.trim()) return { ok: false, error: 'That code does not match.' }
    const state = this.load()
    state.paired[deviceId] = {
      deviceId,
      name: request.name,
      secret: request.secret,
      grants: [], // nothing is granted by pairing alone
      pairedAt: new Date().toISOString()
    }
    this.persist()
    this.pending.delete(deviceId)
    // Tell the requester, or it sits showing "Not connected" forever while this
    // side shows "Connected" -- the two views must agree.
    void this.notifyApproved(deviceId, request.secret)
    return { ok: true }
  }

  rejectPair(deviceId: string): void {
    this.pending.delete(deviceId)
  }

  /** Confirm our own outgoing pair once the far side approved it. */
  confirmOutgoing(deviceId: string, name: string): void {
    const offer = this.outgoing.get(deviceId)
    if (!offer) return
    const state = this.load()
    state.paired[deviceId] = {
      deviceId,
      name,
      secret: offer.secret,
      grants: [],
      pairedAt: new Date().toISOString()
    }
    this.persist()
    this.outgoing.delete(deviceId)
  }

  setGrants(deviceId: string, grants: Permission[]): { ok: boolean; error?: string } {
    const state = this.load()
    const record = state.paired[deviceId]
    if (!record) return { ok: false, error: 'That device is not paired.' }
    const allowed: Permission[] = ['view', 'read', 'write']
    record.grants = grants.filter((g) => allowed.includes(g))
    this.persist()
    return { ok: true }
  }

  unpair(deviceId: string): void {
    const state = this.load()
    delete state.paired[deviceId]
    this.persist()
    const peer = this.seen.get(deviceId)
    if (peer) this.seen.set(deviceId, { ...peer, paired: false, grants: [] })
  }

  /** Call a paired peer with a signed request. */
  private async call(deviceId: string, path: string, method = 'GET', payload?: unknown) {
    const state = this.load()
    const record = state.paired[deviceId]
    const peer = this.seen.get(deviceId)
    if (!record) throw new Error('That device is not paired.')
    if (!peer || !peer.port) throw new Error('That device is offline.')
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const timestamp = String(Date.now())
    const signature = this.sign(record.secret, method, path.split('?')[0]!, timestamp, body)
    const response = await fetch(`http://${peer.address}:${peer.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-utility-device': state.deviceId,
        'x-utility-timestamp': timestamp,
        'x-utility-signature': signature
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(15000)
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error
        } catch {
          return undefined
        }
      })()
      throw new Error(detail ?? `Device returned ${response.status}`)
    }
    return JSON.parse(text) as unknown
  }

  browse(deviceId: string): Promise<unknown> {
    return this.call(deviceId, '/mesh/summary')
  }

  fetchRecord(deviceId: string, id: string): Promise<unknown> {
    return this.call(deviceId, `/mesh/record?id=${encodeURIComponent(id)}`)
  }

  pushRecord(deviceId: string, record: unknown): Promise<unknown> {
    return this.call(deviceId, '/mesh/push', 'POST', record)
  }
}

export const mesh = new Mesh()
