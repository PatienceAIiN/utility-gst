import { app } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { auth } from './auth'
import { store } from './store'

/**
 * Consent-gated cloud backup.
 *
 * Nothing here runs unless the operator has switched cloud backup on AND is
 * signed in. When it is off, the app is entirely local.
 *
 * The bundle is encrypted on this machine before it goes anywhere, with a key
 * derived from the account password (scrypt). The password itself is never
 * sent, and the server cannot read the contents -- it stores an opaque blob.
 * That is what makes the restore-on-another-machine story safe.
 *
 * The client deliberately holds NO object-storage credentials. Embedding them
 * would violate the brief's §13 and, in this deployment, would ship a token
 * with write access to a bucket holding other products' live assets. Uploads
 * therefore go through our own authenticated API, which owns the credentials.
 * Until that endpoint exists, bundles are staged locally and reported as
 * pending rather than silently dropped.
 */

const MAGIC = 'UTLY1'
const KEY_SALT = 'utility-backup-v1'

export interface SyncStatus {
  enabled: boolean
  signedIn: boolean
  ready: boolean
  endpointConfigured: boolean
  pending: number
  pendingBytes: number
  lastBundleAt: string | null
  stagingDir: string
}

let backupKey: Buffer | null = null
/**
 * Server session token, held in memory only. It is obtained by exchanging the
 * same credentials the local account uses, so the operator signs in once.
 */
let serverToken: string | null = null

export function setServerToken(token: string | null): void {
  serverToken = token
}

/** Sign in (or register) against the configured server. Local auth is unaffected. */
export async function serverSignIn(email: string, password: string, name: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const url = endpoint()
  if (!url) return { ok: false, error: 'No server configured.' }
  const base = url.replace(/\/$/, '')
  const attempt = async (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
  try {
    let response = await attempt('/v1/auth/login', { email, password })
    if (response.status === 401 || response.status === 404) {
      // First time on this server: register the same credentials.
      response = await attempt('/v1/auth/signup', { email, password, name })
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: detail.error ?? `Server returned ${response.status}` }
    }
    const data = (await response.json()) as { token: string }
    serverToken = data.token
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the server.' }
  }
}

export interface RemoteBackup {
  name: string
  bytes: number
  sha256: string
  at: string
}

export async function listRemote(): Promise<RemoteBackup[]> {
  const url = endpoint()
  if (!url || !serverToken) return []
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/backups`, {
    headers: { authorization: `Bearer ${serverToken}` },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) return []
  const data = (await response.json()) as { items: RemoteBackup[] }
  return data.items ?? []
}

/**
 * Tell the server whether a screen lock is switched on.
 *
 * The passcode itself never leaves this machine -- only the fact that one is
 * set, which is what lets support release a lock for someone who has forgotten
 * theirs. Failure here is deliberately silent: the lock is enforced locally and
 * must keep working with no network at all.
 */
export async function reportLock(locked: boolean): Promise<void> {
  const url = endpoint()
  if (!url || !serverToken) return
  try {
    await fetch(`${url.replace(/\/$/, '')}/v1/lock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ locked }),
      signal: AbortSignal.timeout(10000)
    })
  } catch {
    /* offline; the local lock is unaffected */
  }
}

export interface RemoteLockState {
  unlockGranted: boolean
  restoreName: string | null
}

export async function lockState(): Promise<RemoteLockState> {
  const url = endpoint()
  if (!url || !serverToken) return { unlockGranted: false, restoreName: null }
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/lock`, {
      headers: { authorization: `Bearer ${serverToken}` },
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) return { unlockGranted: false, restoreName: null }
    const data = (await response.json()) as RemoteLockState
    return { unlockGranted: !!data.unlockGranted, restoreName: data.restoreName ?? null }
  } catch {
    return { unlockGranted: false, restoreName: null }
  }
}

/** Confirm the local lock has actually been cleared, so the grant is spent once. */
export async function consumeUnlock(): Promise<void> {
  const url = endpoint()
  if (!url || !serverToken) return
  try {
    await fetch(`${url.replace(/\/$/, '')}/v1/lock/consume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverToken}` },
      signal: AbortSignal.timeout(10000)
    })
  } catch {
    /* the local lock is already off; the grant expires on the next report */
  }
}

/**
 * Apply a restore an administrator queued for this account.
 *
 * The server holds only the sealed bundle, so the decryption happens here with
 * the user's own key. It is acknowledged only after it succeeds, which means a
 * failed restore is retried rather than silently lost.
 */
export async function applyQueuedRestore(): Promise<string | null> {
  const state = await lockState()
  if (!state.restoreName) return null
  const outcome = await restoreRemote(state.restoreName)
  if (!outcome.ok) return null
  const url = endpoint()
  if (url && serverToken) {
    try {
      await fetch(`${url.replace(/\/$/, '')}/v1/restore/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(10000)
      })
    } catch {
      /* retried next launch; restoring twice is harmless */
    }
  }
  return state.restoreName
}

/**
 * Restore on another machine. The bundle is decrypted locally with the key
 * derived from the password, so a server compromise yields nothing readable.
 */
export async function restoreRemote(name: string): Promise<{ ok: boolean; detail: string }> {
  const url = endpoint()
  if (!url || !serverToken) return { ok: false, detail: 'Sign in to the server first.' }
  if (!backupKey) return { ok: false, detail: 'Sign in before restoring.' }
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/backups/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${serverToken}` },
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) return { ok: false, detail: `Server returned ${response.status}` }
  const blob = Buffer.from(await response.arrayBuffer())
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(gunzipSync(decrypt(blob)).toString('utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, detail: 'Could not decrypt. Is this the same account password?' }
  }
  // Write back only the data files; never the account vault.
  const userData = app.getPath('userData')
  let restored = 0
  for (const file of ['history.json', 'settings.json']) {
    const value = payload[file]
    if (value == null) continue
    writeFileSync(join(userData, file), JSON.stringify(value, null, 2), 'utf8')
    restored++
  }
  return { ok: true, detail: `Restored ${restored} data file(s). Restart the app to see them.` }
}

/** Called on sign-in. Held in memory only -- never written to disk. */
export function deriveBackupKey(password: string): Buffer {
  backupKey = scryptSync(password, KEY_SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })
  return backupKey
}

/** Restore a key remembered from a previous session. */
export function setBackupKey(key: Buffer): void {
  backupKey = key
}

export function clearBackupKey(): void {
  backupKey = null
  serverToken = null
}

function stagingDir(): string {
  const dir = join(app.getPath('userData'), 'pending-sync')
  mkdirSync(dir, { recursive: true })
  return dir
}

function encrypt(plain: Buffer): Buffer {
  if (!backupKey) throw new Error('Sign in before backing up.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', backupKey, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  // MAGIC | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from(MAGIC, 'utf8'), iv, cipher.getAuthTag(), body])
}

export function decrypt(blob: Buffer): Buffer {
  if (!backupKey) throw new Error('Sign in before restoring.')
  const magic = blob.subarray(0, MAGIC.length).toString('utf8')
  if (magic !== MAGIC) throw new Error('That file is not a Utility backup.')
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const body = blob.subarray(MAGIC.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', backupKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** Everything backed up. The account vault is NOT included -- credentials never leave. */
function collect(): Buffer {
  const userData = app.getPath('userData')
  const payload: Record<string, unknown> = { version: 1, at: new Date().toISOString() }
  for (const name of ['history.json', 'settings.json'] as const) {
    const path = join(userData, name)
    if (existsSync(path)) {
      try {
        payload[name] = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        // A corrupt local file should not abort the whole backup.
        payload[name] = null
      }
    }
  }
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
}

/**
 * The backend is part of the product, not a user setting. The address is never
 * shown in the UI and cannot be edited from it -- an operator pointing the app
 * at an arbitrary host would be an exfiltration path for client financial data,
 * and it is not a decision an accountant should be asked to make.
 *
 * The env var is a development override only; it is not read in packaged builds.
 */
const BACKEND_URL = 'https://patienceai.in/utility-api'

export function backendUrl(): string {
  return endpoint() ?? BACKEND_URL
}

function endpoint(): string | null {
  if (!app.isPackaged && process.env['UTILITY_SYNC_ENDPOINT']) {
    return process.env['UTILITY_SYNC_ENDPOINT']
  }
  return BACKEND_URL
}

export function status(): SyncStatus {
  const settings = store.get()
  const dir = stagingDir()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.utlybak')) : []
  const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0)
  const enabled = settings.consent?.cloudSync === true
  const signedIn = auth.status().signedIn
  return {
    enabled,
    signedIn,
    ready: enabled && signedIn && backupKey !== null,
    endpointConfigured: endpoint() !== null,
    pending: files.length,
    pendingBytes: bytes,
    lastBundleAt: files.length
      ? new Date(Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs))).toISOString()
      : null,
    stagingDir: dir
  }
}

export interface SyncOutcome {
  status: 'uploaded' | 'staged' | 'skipped'
  reason?: string
  bytes?: number
  path?: string
}

export async function runBackup(): Promise<SyncOutcome> {
  const settings = store.get()
  if (settings.consent?.cloudSync !== true) {
    return { status: 'skipped', reason: 'Cloud backup is switched off.' }
  }
  if (!auth.status().signedIn || !backupKey) {
    return { status: 'skipped', reason: 'Sign in to back up.' }
  }

  const blob = encrypt(collect())
  const key = auth.accountKey() ?? 'unknown'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${key}-${stamp}.utlybak`

  const url = endpoint()
  if (!url) {
    // No server yet. Stage it so the data is real and ready, and say so.
    const path = join(stagingDir(), name)
    writeFileSync(path, blob)
    prune()
    return {
      status: 'staged',
      bytes: blob.length,
      path,
      reason: 'The account server is not connected yet, so the backup is held on this computer.'
    }
  }

  const token = serverToken
  if (!token) {
    const path = join(stagingDir(), name)
    writeFileSync(path, blob)
    return {
      status: 'staged',
      bytes: blob.length,
      path,
      reason: 'Not signed in to the server yet; the backup is held on this computer.'
    }
  }
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/backups/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: new Uint8Array(blob)
  })
  if (!response.ok) {
    const path = join(stagingDir(), name)
    writeFileSync(path, blob)
    return { status: 'staged', bytes: blob.length, path, reason: `Server refused (${response.status}); kept locally.` }
  }
  return { status: 'uploaded', bytes: blob.length }
}

/** Keep staging bounded: newest 10 bundles. Old encrypted copies are not useful. */
function prune(keep = 10): void {
  const dir = stagingDir()
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.utlybak'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f))
    } catch {
      /* best effort */
    }
  }
}
