import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, IconButton, InputAdornment, Paper, Stack, Switch, Tab, Tabs, TextField,
  Typography
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import LockResetIcon from '@mui/icons-material/LockReset'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import type { AuthStatus, PublicAccount, SyncStatus } from '../../preload/index'
import { Busy, Section, type ConfirmSpec } from '../ui'

/**
 * Accounts live on this computer. Sign-up, sign-in and profile editing involve
 * no network at all. Only two things reach a server: sending a password-reset
 * code by email, and cloud backup -- and backup is off unless switched on.
 */

const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

const CARD = { p: 3, maxWidth: 480, width: '100%', mx: 'auto' } as const

/** Password field with a reveal toggle. */
function Secret({
  label,
  value,
  onChange,
  helper,
  autoComplete
}: {
  label: string
  value: string
  onChange: (v: string) => void
  helper?: string
  autoComplete?: string
}): JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <TextField
      size="small"
      label={label}
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      helperText={helper}
      autoComplete={autoComplete ?? 'off'}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <IconButton
              size="small"
              edge="end"
              aria-label={show ? 'Hide password' : 'Show password'}
              onClick={() => setShow((s) => !s)}
              tabIndex={-1}
            >
              {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
            </IconButton>
          </InputAdornment>
        )
      }}
    />
  )
}

export default function Account({
  cloudEnabled,
  onCloudToggle,
  onAuthChange,
  confirm
}: {
  cloudEnabled: boolean
  onCloudToggle: (on: boolean) => void
  onAuthChange: () => void
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [tab, setTab] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [otpSent, setOtpSent] = useState(false)

  const [form, setForm] = useState({ email: '', password: '', name: '', org: '', gstin: '', code: '' })
  const [profile, setProfile] = useState({ name: '', org: '', gstin: '' })
  const [pw, setPw] = useState({ current: '', next: '' })

  const refresh = useCallback(async () => {
    const next = await window.api.auth.status()
    setStatus(next)
    setSync(await window.api.sync.status())
    onAuthChange()
    if (next.account) {
      setProfile({
        name: next.account.name,
        org: next.account.org ?? '',
        gstin: next.account.gstin ?? ''
      })
    }
  }, [onAuthChange])

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

  // ---------- signed out ----------
  if (status && !status.signedIn) {
    const hasAccount = status.hasAccount
    // With no account yet there is nothing to sign in to, so only offer sign-up.
    const mode: 'signin' | 'signup' | 'reset' =
      !hasAccount ? 'signup' : tab === 0 ? 'signin' : 'reset'

    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 2 }}>
        <Box sx={{ maxWidth: 480, width: '100%' }}>
          <Typography variant="h6" align="center" sx={{ mb: 0.5 }}>
            {mode === 'signup'
              ? 'Create your account'
              : mode === 'reset'
                ? 'Reset password'
                : 'Sign in'}
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
            Your account is stored on this computer. Nothing is uploaded unless you turn on cloud
            backup.
          </Typography>

          <Paper variant="outlined" sx={CARD}>
            {hasAccount && (
              <Tabs
                value={tab}
                onChange={(_e, v: number) => {
                  setTab(v)
                  setError(null)
                  setOtpSent(false)
                }}
                sx={{ mb: 2 }}
                variant="fullWidth"
              >
                <Tab label="Sign in" />
                <Tab label="Forgot password" />
              </Tabs>
            )}
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

            <Stack spacing={2}>
              {mode === 'signup' && (
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
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />

              {mode === 'reset' && (
                <>
                  <Button
                    variant="outlined"
                    disabled={!form.email || busy !== null}
                    onClick={async () => {
                      setBusy('Sending code…')
                      setError(null)
                      try {
                        const result = await window.api.auth.otpRequest(form.email)
                        if (result.ok) {
                          setOtpSent(true)
                          setNotice(
                            'If that address has an account, a code is on its way. It expires in 15 minutes.'
                          )
                        } else setError(result.error ?? 'Could not send the code.')
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {otpSent ? 'Send another code' : 'Email me a code'}
                  </Button>
                  <TextField
                    size="small"
                    label="6-digit code"
                    value={form.code}
                    onChange={(e) =>
                      setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })
                    }
                    inputProps={{ style: { fontFamily: 'monospace', letterSpacing: 5 } }}
                  />
                </>
              )}

              <Secret
                label={mode === 'signin' ? 'Password' : 'New password'}
                value={form.password}
                onChange={(v) => setForm({ ...form, password: v })}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                {...(mode !== 'signin' ? { helper: 'At least 10 characters.' } : {})}
              />

              {mode === 'signup' && (
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
                </>
              )}

              {mode === 'reset' && (
                <Alert severity="warning">
                  Changing your password makes existing cloud backups unreadable — they are
                  encrypted with a key derived from the old one. Back up again afterwards.
                </Alert>
              )}

              <Button
                variant="contained"
                size="large"
                disabled={
                  busy !== null ||
                  !form.email ||
                  !form.password ||
                  (mode === 'reset' && form.code.length < 4)
                }
                onClick={async () => {
                  setBusy('Working…')
                  try {
                    if (mode === 'signup') {
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
                    } else if (mode === 'reset') {
                      handle(
                        await window.api.auth.otpReset(form.email, form.code, form.password),
                        'Password changed.'
                      )
                    } else {
                      handle(await window.api.auth.signIn(form.email, form.password), 'Signed in.')
                    }
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {mode === 'signup'
                  ? 'Create account'
                  : mode === 'reset'
                    ? 'Change password'
                    : 'Sign in'}
              </Button>
            </Stack>
          </Paper>
        </Box>

        <RecoveryDialog code={recovery} onClose={() => setRecovery(null)} />
      </Box>
    )
  }

  // ---------- signed in ----------
  const account: PublicAccount | null = status?.account ?? null

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto' }}>
      <Section
        title="Profile"
        subtitle={account ? `Signed in as ${account.email}` : ''}
        action={
          <Button
            onClick={() =>
              confirm({
                title: 'Sign out?',
                body: 'Your data stays on this computer. Cloud backup switches off until you sign back in, because the encryption key comes from your password.',
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

        <Paper variant="outlined" sx={CARD}>
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
            <Button
              variant="contained"
              onClick={async () =>
                handle(await window.api.auth.updateProfile(profile), 'Profile saved.')
              }
            >
              Save profile
            </Button>

            <Divider />
            <Typography variant="subtitle2">Change password</Typography>
            <Secret
              label="Current password"
              value={pw.current}
              onChange={(v) => setPw({ ...pw, current: v })}
              autoComplete="current-password"
            />
            <Secret
              label="New password"
              value={pw.next}
              onChange={(v) => setPw({ ...pw, next: v })}
              helper="At least 10 characters."
              autoComplete="new-password"
            />
            <Button
              startIcon={<LockResetIcon />}
              disabled={!pw.current || !pw.next}
              onClick={async () => {
                handle(
                  await window.api.auth.changePassword(pw.current, pw.next),
                  'Password changed.'
                )
                setPw({ current: '', next: '' })
              }}
            >
              Change password
            </Button>
          </Stack>
        </Paper>
      </Section>

      <Section
        title="Cloud backup"
        subtitle="Off by default. Nothing is uploaded until you turn this on."
      >
        <Paper variant="outlined" sx={CARD}>
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
            upload, with a key derived from your password. Your password is never sent and the
            server cannot read the contents. Invoices themselves are never uploaded.
          </Typography>

          {cloudEnabled && sync && (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Chip
                  size="small"
                  color={sync.ready ? 'success' : 'default'}
                  label={sync.ready ? 'Ready' : 'Not ready'}
                />
                {sync.pending > 0 && (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${sync.pending} held locally · ${bytes(sync.pendingBytes)}`}
                  />
                )}
              </Stack>
              <Button
                variant="contained"
                startIcon={<CloudUploadIcon />}
                disabled={busy !== null || !sync.ready}
                onClick={async () => {
                  setBusy('Backing up…')
                  setError(null)
                  try {
                    const result = await window.api.sync.run()
                    if (result.status === 'uploaded')
                      setNotice(`Backed up (${bytes(result.bytes ?? 0)}).`)
                    else if (result.status === 'staged')
                      setNotice(
                        `Backup prepared (${bytes(result.bytes ?? 0)}). ${result.reason ?? ''}`
                      )
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

      <Section title="Delete account" subtitle="Removes this account from this computer.">
        <Paper variant="outlined" sx={{ ...CARD, borderColor: 'error.main' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Your imported invoices and exported registers stay on disk — only the account is
            removed. Because backups are encrypted with a key derived from your password, any
            existing cloud backup becomes permanently unreadable.
          </Typography>
          <Button
            color="error"
            variant="outlined"
            startIcon={<DeleteForeverIcon />}
            onClick={() =>
              confirm({
                title: 'Delete this account?',
                body: `${account?.email ?? 'This account'} will be removed from this computer, cloud backup switched off, and any existing encrypted backup left permanently unreadable. This cannot be undone.`,
                confirmLabel: 'Delete account',
                destructive: true,
                onConfirm: async () => {
                  await window.api.auth.deleteAccount()
                  setNotice(null)
                  await refresh()
                }
              })
            }
          >
            Delete account
          </Button>
        </Paper>
      </Section>

      <RecoveryDialog code={recovery} onClose={() => setRecovery(null)} />
    </Box>
  )
}

function RecoveryDialog({
  code,
  onClose
}: {
  code: string | null
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={code !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Save your recovery code</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          Shown once. It is a backup way in if you cannot receive the email code.
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
