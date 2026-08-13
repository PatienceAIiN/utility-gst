import { useState, type ReactNode } from 'react'
import {
  Alert, Box, Button, Collapse, Dialog, DialogActions, DialogContent, DialogContentText,
  DialogTitle, Fade, FormControlLabel, LinearProgress, Link, MenuItem, Paper, Stack, Switch,
  TextField, Typography
} from '@mui/material'

/** Shared presentational pieces. No business logic lives here. */

export function Brand(): JSX.Element {
  return (
    <Typography variant="caption" color="text.secondary">
      A product of{' '}
      <Link
        component="button"
        variant="caption"
        underline="hover"
        onClick={() => void window.api.shell.openExternal('https://patienceai.in')}
        sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
      >
        Patience AI
      </Link>
    </Typography>
  )
}

export function Section({
  title,
  subtitle,
  action,
  children
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <Fade in timeout={280}>
      <Box sx={{ mb: 4 }}>
        <Stack direction="row" alignItems="flex-start" sx={{ mb: 2 }}>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h6">{title}</Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
          {action}
        </Stack>
        {children}
      </Box>
    </Fade>
  )
}

export function EmptyState({
  title,
  body,
  action
}: {
  title: string
  body: string
  action?: ReactNode
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 6, textAlign: 'center', borderStyle: 'dashed', bgcolor: 'transparent' }}
    >
      <Typography variant="subtitle1" fontWeight={620} gutterBottom>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 560, mx: 'auto' }}>
        {body}
      </Typography>
      {action && <Box sx={{ mt: 3 }}>{action}</Box>}
    </Paper>
  )
}

export function Busy({ show, label }: { show: boolean; label?: string }): JSX.Element {
  return (
    <Collapse in={show}>
      <Box sx={{ mb: 2 }}>
        <LinearProgress />
        {label && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            {label}
          </Typography>
        )}
      </Box>
    </Collapse>
  )
}

export interface ConfirmSpec {
  title: string
  body: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  spec,
  onClose
}: {
  spec: ConfirmSpec | null
  onClose: () => void
}): JSX.Element {
  const [working, setWorking] = useState(false)
  return (
    <Dialog open={spec !== null} onClose={working ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{spec?.title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{spec?.body}</DialogContentText>
      </DialogContent>
      {working && <LinearProgress />}
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={working}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={spec?.destructive ? 'error' : 'primary'}
          disabled={working}
          onClick={async () => {
            setWorking(true)
            try {
              await spec?.onConfirm()
              onClose()
            } finally {
              setWorking(false)
            }
          }}
        >
          {spec?.confirmLabel ?? 'Confirm'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function FeedbackDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [kind, setKind] = useState<'bug' | 'idea' | 'other'>('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'queued' | 'failed'>('idle')
  const [detail, setDetail] = useState('')

  function reset(): void {
    setMessage('')
    setState('idle')
    setDetail('')
  }

  return (
    <Dialog open={open} onClose={state === 'sending' ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Send feedback</DialogTitle>
      <DialogContent>
        {state === 'queued' ? (
          <Alert severity={detail ? 'info' : 'success'} sx={{ mb: 1 }}>
            {detail || 'Thank you — your feedback has been sent.'}
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            {state === 'failed' && <Alert severity="error">{detail}</Alert>}
            <TextField
              select
              size="small"
              label="Type"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <MenuItem value="bug">Something is wrong</MenuItem>
              <MenuItem value="idea">Suggestion</MenuItem>
              <MenuItem value="other">Other</MenuItem>
            </TextField>
            <TextField
              label="What happened?"
              multiline
              minRows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe what you expected and what happened instead."
            />
            <TextField
              size="small"
              label="Email (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              helperText="Only if you want a reply."
            />
            <Typography variant="caption" color="text.secondary">
              No invoice data, amounts or party names are attached to feedback.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      {state === 'sending' && <LinearProgress />}
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          onClick={() => {
            reset()
            onClose()
          }}
          disabled={state === 'sending'}
        >
          {state === 'queued' ? 'Close' : 'Cancel'}
        </Button>
        {state !== 'queued' && (
          <Button
            variant="contained"
            disabled={message.trim().length === 0 || state === 'sending'}
            onClick={async () => {
              setState('sending')
              const result = await window.api.feedback.send(kind, message.trim(), email.trim())
              setDetail(
                result.status === 'queued'
                  ? 'Saved on this computer and will be sent automatically once you are back online.'
                  : ''
              )
              setState('queued')
            }}
          >
            Send
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

export function ConsentBanner({
  open,
  onDecide
}: {
  open: boolean
  onDecide: (analytics: boolean, cloudSync: boolean) => void
}): JSX.Element {
  const [analytics, setAnalytics] = useState(false)
  const [cloudSync, setCloudSync] = useState(false)

  return (
    <Dialog open={open} maxWidth="sm" fullWidth disableEscapeKeyDown>
      <DialogTitle>Before you start</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Utility works entirely on this computer. Invoices are parsed, validated and exported
          locally — <strong>no file is ever uploaded</strong>, and your clients&apos; financial data
          does not leave this machine by default.
        </DialogContentText>
        <DialogContentText variant="body2" sx={{ mb: 2 }}>
          The two options below are off unless you turn them on, and you can change them at any
          time in Settings.
        </DialogContentText>
        <Stack spacing={1}>
          <FormControlLabel
            control={<Switch checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} />}
            label={
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  Anonymous diagnostics
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Crash reports and error codes only. Never amounts, GSTINs or party names.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={<Switch checked={cloudSync} onChange={(e) => setCloudSync(e.target.checked)} />}
            label={
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  Cloud backup
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Encrypted, compressed backups of your register data so you can restore it on
                  another machine. Off by default.
                </Typography>
              </Box>
            }
          />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          You can withdraw consent or request deletion at any time, in line with the Digital
          Personal Data Protection Act, 2023.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={() => onDecide(false, false)}>Use offline only</Button>
        <Button variant="contained" onClick={() => onDecide(analytics, cloudSync)}>
          Save choices
        </Button>
      </DialogActions>
    </Dialog>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl + O', 'Import invoices'],
  ['Ctrl + Shift + O', 'Open a spreadsheet'],
  ['Ctrl + E', 'Export the register'],
  ['Ctrl + S', 'Save the spreadsheet'],
  ['Ctrl + 1 … 5', 'Jump to Invoices, History, Spreadsheets, Local network, Profile'],
  ['Ctrl + ,', 'Settings'],
  ['Ctrl + Shift + L', 'Switch light / dark'],
  ['Ctrl + F', 'Find'],
  ['Ctrl + / ', 'This list'],
  ['Ctrl + + / −', 'Zoom in or out'],
  ['F11', 'Full screen']
]

export function ShortcutsDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.1}>
          {SHORTCUTS.map(([keys, what]) => (
            <Stack key={keys} direction="row" spacing={2} alignItems="baseline">
              <Typography
                variant="body2"
                sx={{ minWidth: 148, fontFamily: 'monospace', fontWeight: 600 }}
              >
                {keys}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {what}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Shown once after an update has been applied. */
export function UpdatedDialog({
  version,
  onClose
}: {
  version: string | null
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={version !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogContent sx={{ textAlign: 'center', py: 4 }}>
        <Box
          sx={{
            width: 68,
            height: 68,
            mx: 'auto',
            mb: 2,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'success.main',
            color: '#fff',
            fontSize: 34,
            animation: 'pop .45s cubic-bezier(.2,.8,.3,1)',
            '@keyframes pop': {
              from: { transform: 'scale(.5)', opacity: 0 },
              to: { transform: 'scale(1)', opacity: 1 }
            }
          }}
        >
          ✓
        </Box>
        <Typography variant="h6" gutterBottom>
          Updated to {version}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Utility is now up to date. Nothing else is needed.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'center' }}>
        <Button variant="contained" onClick={onClose}>
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Offered when a downloaded update is waiting to be applied. */
export function UpdateReadyDialog({
  version,
  onClose
}: {
  version: string | null
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={version !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Version {version} is ready</DialogTitle>
      <DialogContent>
        <DialogContentText>
          The update has downloaded. It will be applied when you close Utility — your work is never
          interrupted mid-way.
        </DialogContentText>
        <Alert severity="info" sx={{ mt: 2 }}>
          Closing now takes a few seconds. Anything unsaved in the review grid or the spreadsheet
          editor will be lost, so finish what you are doing first.
        </Alert>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Later</Button>
        <Button variant="contained" onClick={() => void window.api.updates.install()}>
          Close and update
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Update requires an account. */
export function SignInRequiredDialog({
  open,
  onClose,
  onGoToProfile
}: {
  open: boolean
  onClose: () => void
  onGoToProfile: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Sign in to receive updates</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Updates are tied to your account. Create one or sign in — it takes a moment and stays on
          this computer.
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Not now</Button>
        <Button
          variant="contained"
          onClick={() => {
            onGoToProfile()
            onClose()
          }}
        >
          Go to Profile
        </Button>
      </DialogActions>
    </Dialog>
  )
}
