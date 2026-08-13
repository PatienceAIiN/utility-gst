import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, Paper, Stack, Switch, Tab, Tabs, TextField, Typography
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import LockResetIcon from '@mui/icons-material/LockReset'
import type { AuthStatus, PublicAccount, SyncStatus } from '../../preload/index'
import { Busy, Section, type ConfirmSpec } from '../ui'

/**
 * Accounts live on this computer. Sign-up, sign-in and password reset involve no
 * network at all. Only cloud backup, which is off by default, sends anything.
 */

const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

export default function Account({
  cloudEnabled,
  onCloudToggle,
  confirm
}: {
  cloudEnabled: boolean
  onCloudToggle: (on: boolean) => void
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [tab, setTab] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)

  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    org: '',
    gstin: '',
    recoveryCode: ''
  })
  const [profile, setProfile] = useState({ name: '', org: '', gstin: '' })
  const [pw, setPw] = useState({ current: '', next: '' })

  const refresh = useCallback(async () => {
    const s = await window.api.auth.status()
    setStatus(s)
    setSync(await window.api.sync.status())
    if (s.account) {
      setProfile({ name: s.account.name, org: s.account.org ?? '', gstin: s.account.gstin ?? '' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function handle(result: { ok: boolean; error?: string; recoveryCode?: string }, ok: string): void {
    if (result.ok) {
      setError(null)
      setNotice(ok)
      if (result.recoveryCode) setRecovery(result.recoveryCode)
      void refresh()
    } else {
      setNotice(null)
      setError(result.error ?? 'Something went wrong')
    }
  }

  // --- signed out ---------------------------------------------------------
  if (status && !status.signedIn) {
    const isSignUp = !status.hasAccount || tab === 1
    return (
      <Section
        title={status.hasAccount ? 'Sign in' : 'Create your account'}
        subtitle="Your account is stored on this computer. Nothing is sent anywhere unless you turn cloud backup on."
      >
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 520 }}>
          {status.hasAccount && (
            <Tabs value={tab} onChange={(_e, v: number) => setTab(v)} sx={{ mb: 2 }}>
              <Tab label="Sign in" />
              <Tab label="Reset password" />
            </Tabs>
          )}
          <Busy show={busy !== null} label={busy ?? undefined} />
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Stack spacing={2}>
            {!status.hasAccount && (
              <TextField
                size="small"
                label="Your name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
            <TextField
              size="small"
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            {status.hasAccount && tab === 1 && (
              <TextField
                size="small"
                label="Recovery code"
                placeholder="ABCD-1234-EF56-7890"
                value={form.recoveryCode}
                onChange={(e) => setForm({ ...form, recoveryCode: e.target.value })}
                helperText="The code shown when you created the account."
              />
            )}
            <TextField
              size="small"
              label={tab === 1 && status.hasAccount ? 'New password' : 'Password'}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              helperText={isSignUp ? 'At least 10 characters.' : ' '}
            />
            {!status.hasAccount && (
              <>
                <TextField
                  size="small"
                  label="Organisation (optional)"
                  value={form.org}
                  onChange={(e) => setForm({ ...form, org: e.target.value })}
                />
                <TextField
                  size="small"
                  label="GSTIN (optional)"
                  value={form.gstin}
                  onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                />
                <Alert severity="info">
                  You will be shown a recovery code once. It is the only way to reset your password,
                  because nothing is stored on a server — keep it somewhere safe.
                </Alert>
              </>
            )}

            <Button
              variant="contained"
              disabled={busy !== null || !form.email || !form.password}
              onClick={async () => {
                setBusy('Working…')
                try {
                  if (!status.hasAccount) {
                    handle(
                      await window.api.auth.signUp({
                        email: form.email,
                        password: form.password,
                        name: form.name,
                        org: form.org,
                        gstin: form.gstin
                      }),
                      'Account created.'
                    )
                  } else if (tab === 1) {
                    handle(
                      await window.api.auth.reset(form.email, form.recoveryCode, form.password),
                      'Password reset.'
                    )
                  } else {
                    handle(await window.api.auth.signIn(form.email, form.password), 'Signed in.')
                  }
                } finally {
                  setBusy(null)
                }
              }}
            >
              {!status.hasAccount ? 'Create account' : tab === 1 ? 'Reset password' : 'Sign in'}
            </Button>
          </Stack>
        </Paper>

        <RecoveryDialog code={recovery} onClose={() => setRecovery(null)} />
      </Section>
    )
  }

  // --- signed in ----------------------------------------------------------
  const account: PublicAccount | null = status?.account ?? null

  return (
    <Box>
      <Section
        title="Profile"
        subtitle={account ? `Signed in as ${account.email}` : ''}
        action={
          <Button
            onClick={() =>
              confirm({
                title: 'Sign out?',
                body: 'Your data stays on this computer. You will need your password to sign back in.',
                confirmLabel: 'Sign out',
                onConfirm: async () => {
                  await window.api.auth.signOut()
                  await refresh()
                }
              })
            }
          >
            Sign out
          </Button>
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

        <Paper variant="outlined" sx={{ p: 3, maxWidth: 560 }}>
          <Stack spacing={2}>
            <TextField
              size="small"
              label="Name"
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
            <TextField
              size="small"
              label="Organisation"
              value={profile.org}
              onChange={(e) => setProfile({ ...profile, org: e.target.value })}
            />
            <TextField
              size="small"
              label="GSTIN"
              value={profile.gstin}
              onChange={(e) => setProfile({ ...profile, gstin: e.target.value })}
            />
            <Box>
              <Button
                variant="contained"
                onClick={async () => handle(await window.api.auth.updateProfile(profile), 'Profile saved.')}
              >
                Save profile
              </Button>
            </Box>

            <Divider />
            <Typography variant="subtitle2">Change password</Typography>
            <TextField
              size="small"
              label="Current password"
              type="password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
            />
            <TextField
              size="small"
              label="New password"
              type="password"
              value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })}
            />
            <Box>
              <Button
                startIcon={<LockResetIcon />}
                disabled={!pw.current || !pw.next}
                onClick={async () => {
                  handle(await window.api.auth.changePassword(pw.current, pw.next), 'Password changed.')
                  setPw({ current: '', next: '' })
                }}
              >
                Change password
              </Button>
            </Box>
          </Stack>
        </Paper>
      </Section>

      <Section
        title="Cloud backup"
        subtitle="Off by default. When off, this application does not talk to any server."
      >
        <Paper variant="outlined" sx={{ p: 3, maxWidth: 720 }}>
          <FormControlLabel
            control={
              <Switch
                checked={cloudEnabled}
                onChange={(e) => {
                  onCloudToggle(e.target.checked)
                  setTimeout(() => void refresh(), 150)
                }}
              />
            }
            label="Sync with cloud"
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Your register data is compressed and <strong>encrypted on this computer</strong> before
            it is uploaded, using a key derived from your password. Your password is never sent, and
            the server cannot read the contents. Invoices themselves are never uploaded.
          </Typography>

          {cloudEnabled && sync && (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={sync.ready ? 'Ready' : 'Not ready'} color={sync.ready ? 'success' : 'default'} />
                <Chip
                  size="small"
                  variant="outlined"
                  label={sync.endpointConfigured ? 'Server connected' : 'Server not connected'}
                />
                {sync.pending > 0 && (
                  <Chip size="small" variant="outlined" label={`${sync.pending} held locally · ${bytes(sync.pendingBytes)}`} />
                )}
              </Stack>

              {!sync.endpointConfigured && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  The account server is not connected yet. Backups are still created and encrypted,
                  and are held on this computer until it is — nothing is silently discarded.
                </Alert>
              )}

              <Button
                variant="contained"
                startIcon={<CloudUploadIcon />}
                disabled={busy !== null || !sync.ready}
                onClick={async () => {
                  setBusy('Backing up…')
                  setError(null)
                  try {
                    const result = await window.api.sync.run()
                    if (result.status === 'uploaded') setNotice(`Backed up (${bytes(result.bytes ?? 0)}).`)
                    else if (result.status === 'staged')
                      setNotice(`Backup prepared (${bytes(result.bytes ?? 0)}). ${result.reason ?? ''}`)
                    else setError(result.reason ?? 'Backup skipped')
                    await refresh()
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                Back up now
              </Button>
              {sync.lastBundleAt && (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
                  Last backup {new Date(sync.lastBundleAt).toLocaleString()}
                </Typography>
              )}
            </>
          )}
        </Paper>
      </Section>

      <RecoveryDialog code={recovery} onClose={() => setRecovery(null)} />
    </Box>
  )
}

function RecoveryDialog({ code, onClose }: { code: string | null; onClose: () => void }): JSX.Element {
  return (
    <Dialog open={code !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Save your recovery code</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          This is shown once and cannot be retrieved later. Without it, a forgotten password cannot
          be reset — there is no server holding a copy.
        </Alert>
        <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
          <Typography variant="h6" fontFamily="monospace" letterSpacing={2}>
            {code}
          </Typography>
        </Paper>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          I have written it down
        </Button>
      </DialogActions>
    </Dialog>
  )
}
