import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  Divider, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, TextField, Tooltip,
  Typography
} from '@mui/material'
import LanIcon from '@mui/icons-material/Lan'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { MeshStatus, Permission } from '../../preload/index'
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
  const [myCode, setMyCode] = useState<{ device: string; code: string } | null>(null)
  const [approving, setApproving] = useState<{ deviceId: string; name: string } | null>(null)
  const [codeEntry, setCodeEntry] = useState('')
  const [name, setName] = useState('')

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
                              setMyCode({ device: peer.name, code: result.code })
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
                          disabled={!peer.grants.includes('view') || !peer.address}
                          onClick={async () => {
                            setError(null)
                            try {
                              const data = await window.api.mesh.browse(peer.deviceId)
                              setNotice(`${peer.name} has ${data.count} record(s).`)
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not read that device.')
                            }
                          }}
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
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={() => setMyCode(null)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>

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
