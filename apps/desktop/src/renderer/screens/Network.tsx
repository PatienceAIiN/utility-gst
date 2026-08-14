import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  CircularProgress, Divider, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography
} from '@mui/material'
import LanIcon from '@mui/icons-material/Lan'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { MeshPeer, MeshStatus, Permission } from '../../preload/index'
import { Busy, EmptyState, Section, type ConfirmSpec } from '../ui'

/**
 * Local network sharing. Off by default; nothing listens or broadcasts until
 * the operator switches it on. Pairing needs a matching code on both devices,
 * and permissions start at none.
 */

/**
 * Access is offered as one escalating choice rather than three independent
 * toggles. The levels genuinely nest -- opening a record is meaningless without
 * seeing the list -- so three checkboxes allowed contradictory combinations
 * (write without view) that had to be reasoned about but never made sense.
 */
const LEVELS: { value: string; label: string; grants: Permission[]; hint: string }[] = [
  { value: 'none', label: 'No access', grants: [], hint: 'Connected, but cannot see anything.' },
  {
    value: 'view',
    label: 'View only',
    grants: ['view'],
    hint: 'Sees invoice numbers, dates and row counts. No amounts, GSTINs or party names.'
  },
  {
    value: 'read',
    label: 'Read',
    grants: ['view', 'read'],
    hint: 'Can open full records, including amounts and party details.'
  },
  {
    value: 'write',
    label: 'Read and write',
    grants: ['view', 'read', 'write'],
    hint: 'Can also send records to this computer, which appear in your History.'
  }
]

const levelOf = (grants: Permission[]): string => {
  if (grants.includes('write')) return 'write'
  if (grants.includes('read')) return 'read'
  if (grants.includes('view')) return 'view'
  return 'none'
}

export default function Network({
  confirm
}: {
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [status, setStatus] = useState<MeshStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [myCode, setMyCode] = useState<{ device: string; deviceId: string; code: string } | null>(null)
  const [approving, setApproving] = useState<{ deviceId: string; name: string } | null>(null)
  const [codeEntry, setCodeEntry] = useState('')
  const [name, setName] = useState('')
  const [browsing, setBrowsing] = useState<MeshPeer | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.mesh.status()
      setStatus(next)
      setName((current) => current || next.deviceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read network status')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => clearInterval(timer)
  }, [refresh])

  // Dismiss the pairing code the moment the far side approves: it is spent, and
  // a stale secret left on screen is worse than no feedback at all.
  useEffect(() => {
    if (!myCode || !status) return
    const peer = status.peers.find((p) => p.deviceId === myCode.deviceId)
    if (peer?.paired) {
      setMyCode(null)
      setNotice(`${peer.name} is connected. Set what they may do below.`)
    }
  }, [status, myCode])

  const enabled = status?.enabled === true

  return (
    <Box>
      <Section
        title="Local network"
        subtitle="Share registers with other Utility installations on this office network. Nothing leaves the network."
        action={
          <FormControlLabel
            control={
              <Switch
                checked={enabled}
                onChange={async (e) => {
                  setBusy(e.target.checked ? 'Starting…' : 'Stopping…')
                  try {
                    setStatus(await window.api.mesh.enable(e.target.checked))
                  } finally {
                    setBusy(null)
                  }
                }}
              />
            }
            label={enabled ? 'On' : 'Off'}
          />
        }
      >
        <Busy show={busy !== null} label={busy ?? undefined} />
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}

        {!enabled ? (
          <EmptyState
            title="Local sharing is off"
            body="While this is off, the application does not listen on the network or announce itself. Turn it on to find other Utility installations in this office and share registers with them."
          />
        ) : (
          <>
            <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                <TextField
                  size="small"
                  label="This computer appears as"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  sx={{ minWidth: 260 }}
                />
                <Button
                  onClick={async () => setStatus(await window.api.mesh.setName(name))}
                  disabled={!name.trim() || name === status?.deviceName}
                >
                  Rename
                </Button>
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title="Refresh">
                  <IconButton onClick={() => void refresh()}>
                    <RefreshIcon />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                Visible on {status?.addresses.join(', ') || 'this network'} · other devices must be
                on the same network and cannot reach this from the internet.
              </Typography>
            </Paper>

            {/* Incoming pair requests */}
            {status?.requests.map((request) => (
              <Alert
                key={request.deviceId}
                severity="warning"
                sx={{ mb: 2 }}
                action={
                  <Stack direction="row" spacing={1}>
                    <Button
                      size="small"
                      onClick={() => {
                        setApproving({ deviceId: request.deviceId, name: request.name })
                        setCodeEntry('')
                      }}
                    >
                      Review
                    </Button>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={async () => setStatus(await window.api.mesh.rejectPair(request.deviceId))}
                    >
                      Reject
                    </Button>
                  </Stack>
                }
              >
                <strong>{request.name}</strong> ({request.address}) wants to connect to this
                computer.
              </Alert>
            ))}

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Devices on this network
            </Typography>
            {status && status.peers.length === 0 ? (
              <EmptyState
                title="No other devices found yet"
                body="Other computers need Utility installed with local sharing turned on, connected to the same network. Discovery takes a few seconds."
              />
            ) : (
              status?.peers.map((peer) => (
                <Paper key={peer.deviceId} variant="outlined" sx={{ p: 2.5, mb: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    <LanIcon fontSize="small" color={peer.address ? 'primary' : 'disabled'} />
                    <Typography variant="body2" fontWeight={620}>
                      {peer.name}
                    </Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={peer.address ? peer.address : 'offline'}
                    />
                    <Chip
                      size="small"
                      color={peer.paired ? 'success' : 'default'}
                      label={peer.paired ? 'Connected' : 'Not connected'}
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    {!peer.paired ? (
                      <Button
                        size="small"
                        variant="contained"
                        disabled={!peer.address}
                        onClick={async () => {
                          setBusy('Requesting…')
                          setError(null)
                          try {
                            const result = await window.api.mesh.requestPair(peer.deviceId)
                            if (result.ok && result.code) {
                              setMyCode({
                                device: peer.name,
                                deviceId: peer.deviceId,
                                code: result.code
                              })
                            } else {
                              setError(result.error ?? 'Could not reach that device.')
                            }
                          } finally {
                            setBusy(null)
                          }
                        }}
                      >
                        Connect
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="small"
                          disabled={!peer.address}
                          onClick={() => setBrowsing(peer)}
                        >
                          Browse
                        </Button>
                        <Tooltip title="Disconnect">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() =>
                              confirm({
                                title: `Disconnect ${peer.name}?`,
                                body: 'Removes the connection and every permission granted to that device. It will need to be approved again to reconnect.',
                                confirmLabel: 'Disconnect',
                                destructive: true,
                                onConfirm: async () =>
                                  setStatus(await window.api.mesh.unpair(peer.deviceId))
                              })
                            }
                          >
                            <LinkOffIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      </>
                    )}
                  </Stack>

                  {peer.paired && (
                    <>
                      <Divider sx={{ my: 1.5 }} />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
                        What {peer.name} may do on this computer. Nothing is allowed until you
                        choose.
                      </Typography>
                      <TextField
                        select
                        size="small"
                        label="Access level"
                        sx={{ minWidth: 240 }}
                        value={levelOf(peer.grants)}
                        onChange={async (e) => {
                          const level = LEVELS.find((l) => l.value === e.target.value)
                          if (!level) return
                          const result = await window.api.mesh.setGrants(peer.deviceId, level.grants)
                          if (!result.ok) setError(result.error ?? 'Could not change permissions')
                          await refresh()
                        }}
                        helperText={LEVELS.find((l) => l.value === levelOf(peer.grants))?.hint}
                      >
                        {LEVELS.map((level) => (
                          <MenuItem key={level.value} value={level.value}>
                            {level.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    </>
                  )}
                </Paper>
              ))
            )}
          </>
        )}
      </Section>

      {/* Code shown to the operator after asking to connect */}
      <Dialog open={myCode !== null} onClose={() => setMyCode(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm on the other computer</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            On <strong>{myCode?.device}</strong>, open Local network and approve the request. It will
            ask for this code:
          </DialogContentText>
          <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h5" fontFamily="monospace" letterSpacing={6}>
              {myCode?.code}
            </Typography>
          </Paper>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
            Read it out rather than sending it over chat. Matching the code is what proves the two
            computers are the ones you intend to connect.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              Waiting for them to approve — this closes by itself.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={() => setMyCode(null)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>

      <BrowseDialog peer={browsing} onClose={() => setBrowsing(null)} />

      {/* Approving an incoming request */}
      <Dialog open={approving !== null} onClose={() => setApproving(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Connect {approving?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Type the 6-digit code shown on <strong>{approving?.name}</strong>. If the codes do not
            match, do not approve — something else is asking to connect.
          </DialogContentText>
          <TextField
            fullWidth
            autoFocus
            label="Code"
            value={codeEntry}
            onChange={(e) => setCodeEntry(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputProps={{ style: { fontFamily: 'monospace', letterSpacing: 6, fontSize: 20 } }}
          />
          <Alert severity="info" sx={{ mt: 2 }}>
            Approving only connects the two computers. It grants no access on its own — you choose
            what they may do afterwards.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setApproving(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={codeEntry.length < 4}
            onClick={async () => {
              if (!approving) return
              const result = await window.api.mesh.approvePair(approving.deviceId, codeEntry)
              if (result.ok) {
                setNotice(`${approving.name} is connected. It has no permissions yet.`)
                setApproving(null)
                await refresh()
              } else {
                setError(result.error ?? 'Could not approve')
              }
            }}
          >
            Approve
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

interface RemoteRecord {
  id: string
  invoiceNo: string | null
  invoiceDate: string | null
  rows: number
  blocked: boolean
}

/**
 * Browsing a paired device.
 *
 * What is shown depends on the level THAT device granted us, and the failure is
 * reported plainly: an empty list because permission was withheld reads very
 * differently from an empty list because nothing has been imported.
 */
function BrowseDialog({
  peer,
  onClose
}: {
  peer: MeshPeer | null
  onClose: () => void
}): JSX.Element {
  const [items, setItems] = useState<RemoteRecord[] | null>(null)
  const [grants, setGrants] = useState<Permission[]>([])
  const [device, setDevice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (!peer) {
      setItems(null)
      setError(null)
      setDetail(null)
      setGrants([])
      return
    }
    setLoading(true)
    setError(null)
    window.api.mesh
      .browse(peer.deviceId)
      .then((data) => {
        setItems((data.items ?? []) as RemoteRecord[])
        setGrants((data.yourGrants ?? []) as Permission[])
        setDevice(data.device ?? peer.name)
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not read that device.')
      )
      .finally(() => setLoading(false))
  }, [peer])

  const money = (v: unknown): string =>
    v == null || v === ''
      ? '—'
      : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <Dialog open={peer !== null} onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <span>{device || peer?.name}</span>
          <Chip
            size="small"
            color={grants.includes('write') ? 'success' : grants.length ? 'primary' : 'default'}
            label={
              grants.includes('write')
                ? 'Read and write'
                : grants.includes('read')
                  ? 'Read'
                  : grants.includes('view')
                    ? 'View only'
                    : 'No access'
            }
          />
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Busy show={loading} label="Reading…" />
        {items && !grants.includes('read') && !error && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You have view-only access, so records cannot be opened. Ask them to raise your access
            level on their computer.
          </Alert>
        )}
        {error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {error}
            {error.toLowerCase().includes('permission') && (
              <> — ask them to raise your access level on their computer.</>
            )}
          </Alert>
        )}

        {detail ? (
          <Box>
            <Button size="small" onClick={() => setDetail(null)} sx={{ mb: 2 }}>
              ← Back to list
            </Button>
            <Stack spacing={1}>
              {(
                [
                  ['Invoice', detail['invoiceNo']],
                  ['Date', detail['invoiceDate']],
                  ['Party', detail['party']],
                  ['GSTIN', detail['gstin']],
                  ['Rows', detail['rows']],
                  ['Taxable', money(detail['taxable'])],
                  ['Tax', money(detail['taxTotal'])],
                  ['Grand total', money(detail['grandTotal'])]
                ] as [string, unknown][]
              ).map(([label, value]) => (
                <Stack key={label} direction="row" spacing={2}>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 110 }}>
                    {label}
                  </Typography>
                  <Typography variant="body2">{String(value ?? '—')}</Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
        ) : items && items.length === 0 && !error ? (
          <Typography variant="body2" color="text.secondary">
            That computer has not processed any invoices yet.
          </Typography>
        ) : (
          items && (
            <TableContainer sx={{ maxHeight: '55vh' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Invoice</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell align="right">Rows</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((record) => (
                    <TableRow key={record.id} hover>
                      <TableCell>{record.invoiceNo ?? '—'}</TableCell>
                      <TableCell>{record.invoiceDate ?? '—'}</TableCell>
                      <TableCell align="right">{record.rows}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={record.blocked ? 'error' : 'success'}
                          label={record.blocked ? 'Needs review' : 'Ties out'}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          disabled={!grants.includes('read')}
                          onClick={async () => {
                            if (!peer) return
                            setError(null)
                            try {
                              const full = await window.api.mesh.fetchRecord(peer.deviceId, record.id)
                              setDetail(full as Record<string, unknown>)
                            } catch (e) {
                              setError(
                                e instanceof Error
                                  ? `${e.message} You may only have "View only" access.`
                                  : 'Could not open that record.'
                              )
                            }
                          }}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {grants.includes('write') && (
          <Button
            sx={{ mr: 'auto' }}
            onClick={() => setSharing(true)}
          >
            Send a record to {device || peer?.name}
          </Button>
        )}
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
      {peer && <ShareDialog open={sharing} peer={peer} onClose={() => setSharing(false)} />}
    </Dialog>
  )
}

/** Push one of our own records to a peer that granted write access. */
function ShareDialog({
  open,
  peer,
  onClose
}: {
  open: boolean
  peer: MeshPeer
  onClose: () => void
}): JSX.Element {
  const [mine, setMine] = useState<{ id: string; invoiceNo: string | null; rows: number }[]>([])
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void window.api.history.list({ page: 1, pageSize: 100 }).then((page) =>
      setMine(page.items.map((r) => ({ id: r.id, invoiceNo: r.invoiceNo, rows: r.rows })))
    )
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Send to {peer.name}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {sent && <Alert severity="success" sx={{ mb: 2 }}>Sent {sent}.</Alert>}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          The record appears in their History, tagged as received from this computer.
        </Typography>
        {mine.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            You have no records to send yet.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {mine.map((record) => (
              <Stack key={record.id} direction="row" alignItems="center" spacing={1}>
                <Typography variant="body2" sx={{ flexGrow: 1 }}>
                  {record.invoiceNo ?? record.id.slice(0, 8)} · {record.rows} rows
                </Typography>
                <Button
                  size="small"
                  onClick={async () => {
                    setError(null)
                    try {
                      await window.api.mesh.share(peer.deviceId, record.id)
                      setSent(record.invoiceNo ?? 'record')
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not send.')
                    }
                  }}
                >
                  Send
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
