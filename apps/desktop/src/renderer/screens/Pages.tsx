import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, Grid, Link, List, ListItem, ListItemText, MenuItem, Paper, Stack, Switch,
  TextField, Typography
} from '@mui/material'
import CloudSyncIcon from '@mui/icons-material/CloudSync'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import type { AppInfo, PathsInfo, Settings as SettingsShape } from '../../preload/index'
import { Section } from '../ui'
import Lock from './Lock'

/**
 * About and Settings. These describe what the product does and what it will not
 * do with your data -- deliberately no detail of how extraction works.
 */

const CARD = { p: 3, maxWidth: 560, width: '100%', mx: 'auto' } as const

const LICENCES = [
  { name: 'Electron', licence: 'MIT', what: 'Desktop application runtime' },
  { name: 'React', licence: 'MIT', what: 'User interface' },
  { name: 'MUI (Material UI)', licence: 'MIT', what: 'Design system components' },
  { name: 'Emotion', licence: 'MIT', what: 'Component styling' },
  { name: 'zod', licence: 'MIT', what: 'Input validation' },
  { name: 'Python', licence: 'PSF License', what: 'Document processing runtime' },
  { name: 'pdfplumber', licence: 'MIT', what: 'PDF text and layout reading' },
  { name: 'pdfminer.six', licence: 'MIT', what: 'PDF parsing' },
  { name: 'pypdfium2', licence: 'Apache-2.0 / BSD-3-Clause', what: 'PDF rendering' },
  { name: 'openpyxl', licence: 'MIT', what: 'Excel (OOXML) reading and writing' },
  { name: 'python-dateutil', licence: 'Apache-2.0 / BSD-3-Clause', what: 'Date parsing' },
  { name: 'Pillow', licence: 'MIT-CMU (HPND)', what: 'Image handling' },
  { name: 'cryptography', licence: 'Apache-2.0 / BSD-3-Clause', what: 'Encrypted document support' }
]

export function AboutDialog({
  open,
  info,
  onClose
}: {
  open: boolean
  info: AppInfo
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth scroll="paper">
      <DialogTitle>About Utility</DialogTitle>
      <DialogContent dividers>
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Why it exists
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Preparing a GST sales register by hand means retyping every line of every invoice into a
            spreadsheet, then reconciling it when the totals do not agree. It is slow, and a single
            mistyped figure is very hard to find later.
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Utility reads the invoices you already have, checks the arithmetic on every line, and
            produces a consolidated sales register. Anything that does not reconcile is held back
            for review rather than written out quietly — a loud failure is always better than a
            silent mismatch in accounting.
          </Typography>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" gutterBottom>
            Your data stays here
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Invoices are read and processed entirely on this computer. No file is uploaded. Cloud
            backup and diagnostics are off unless you switch them on, and can be withdrawn at any
            time from Settings.
          </Typography>

          <Divider sx={{ my: 2 }} />

          <Grid container spacing={2}>
            {[
              ['Version', info.version],
              ['Build', info.buildCode === 'dev' ? 'Development' : `Production ${info.buildCode}`],
              ['Channel', info.channel === 'legacy' ? 'Legacy (Windows 7/8)' : 'Standard'],
              ['Platform', info.platform === 'win32' ? 'Windows' : info.platform]
            ].map(([label, value]) => (
              <Grid item xs={6} sm={3} key={label}>
                <Typography variant="caption" color="text.secondary">
                  {label}
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {value}
                </Typography>
              </Grid>
            ))}
          </Grid>

          <Box sx={{ mt: 3 }}>
            <Typography variant="body2">
              Developed by{' '}
              <Link
                component="button"
                variant="body2"
                underline="hover"
                sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
                onClick={() => void window.api.shell.openExternal('https://patienceai.in')}
              >
                Patience AI
              </Link>
              .
            </Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function LicencesDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth scroll="paper">
      <DialogTitle>Open-source licences</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Utility is built on these projects. Full licence texts ship in the application folder.
        </Typography>
        <List dense disablePadding>
          {LICENCES.map((item, index) => (
            <ListItem key={item.name} divider={index < LICENCES.length - 1} disableGutters>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" fontWeight={600}>
                      {item.name}
                    </Typography>
                    <Chip size="small" variant="outlined" label={item.licence} />
                  </Stack>
                }
                secondary={item.what}
              />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function SettingsScreen({
  info,
  settings,
  signedIn,
  onPatch,
  onConsent
}: {
  info: AppInfo
  settings: SettingsShape | null
  signedIn: boolean
  onPatch: (patch: Partial<Pick<SettingsShape, 'theme' | 'confirmOnExit'>>) => void
  onConsent: (analytics: boolean, cloudSync: boolean) => void
}): JSX.Element {
  const [update, setUpdate] = useState<import('../../preload/index').UpdateState | null>(null)
  const [paths, setPaths] = useState<PathsInfo | null>(null)
  const [lockOn, setLockOn] = useState(false)
  const [capture, setCapture] = useState<'set' | 'disable' | null>(null)
  const [lockMsg, setLockMsg] = useState<string | null>(null)


  useEffect(() => {
    void window.api.updates.state().then(setUpdate)
    return window.api.updates.onState(setUpdate)
  }, [info.version])
  useEffect(() => {
    void window.api.paths.info().then(setPaths)
    void window.api.passcode.status().then((s) => setLockOn(s.enabled))
  }, [])

  const consent = settings?.consent

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto' }}>
      <Section title="Appearance">
        <Paper variant="outlined" sx={CARD}>
          <TextField
            select
            size="small"
            label="Theme"
            sx={{ minWidth: 220 }}
            value={settings?.theme ?? 'system'}
            onChange={(e) => onPatch({ theme: e.target.value as SettingsShape['theme'] })}
          >
            <MenuItem value="system">Match Windows</MenuItem>
            <MenuItem value="light">Light</MenuItem>
            <MenuItem value="dark">Dark</MenuItem>
          </TextField>
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={settings?.confirmOnExit ?? true}
                  onChange={(e) => onPatch({ confirmOnExit: e.target.checked })}
                />
              }
              label="Ask before closing the app"
            />
            <Typography variant="caption" color="text.secondary" display="block">
              A confirmation is always shown while an import or export is running, regardless of
              this setting.
            </Typography>
          </Box>
        </Paper>
      </Section>

      <Section
        title="Where files are saved"
        subtitle="Exported registers and edited spreadsheets go here, organised automatically."
      >
        <Paper variant="outlined" sx={CARD}>
          <Typography variant="body2" sx={{ wordBreak: 'break-all', mb: 1 }}>
            <strong>{paths?.base ?? '…'}</strong>
          </Typography>
          <Box component="ul" sx={{ m: 0, mb: 2, pl: 3 }}>
            {(paths?.entries ?? []).map((entry) => (
              <Typography component="li" variant="caption" color="text.secondary" key={entry}>
                {entry}
              </Typography>
            ))}
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={() => void window.api.paths.pick().then(setPaths)}
            >
              Change folder
            </Button>
            <Button onClick={() => void window.api.paths.reveal()}>Open folder</Button>
            <Button color="inherit" onClick={() => void window.api.paths.reset().then(setPaths)}>
              Reset to default
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
            The folder is created the first time something is saved. Exports never overwrite an
            existing file — each one is written with its own timestamp.
          </Typography>
        </Paper>
      </Section>

      <Section
        title="Screen lock"
        subtitle="Ask for a 4-digit passcode each time Utility opens."
      >
        <Paper variant="outlined" sx={CARD}>
          <FormControlLabel
            control={
              <Switch
                checked={lockOn}
                onChange={(e) => {
                  setLockMsg(null)
                  setCapture(e.target.checked ? 'set' : 'disable')
                }}
              />
            }
            label={
              <Stack direction="row" spacing={1} alignItems="center">
                <LockOutlinedIcon fontSize="small" />
                <span>Require a passcode</span>
              </Stack>
            }
          />
          {lockMsg && (
            <Alert
              severity={/not right|Could not|Avoid|four digits/i.test(lockMsg) ? 'error' : 'success'}
              sx={{ mt: 1.5 }}
              onClose={() => setLockMsg(null)}
            >
              {lockMsg}
            </Alert>
          )}
          <Alert severity="info" sx={{ mt: 2 }}>
            This stops someone opening Utility on an unattended machine. It is not encryption —
            four digits is a small number of combinations, and it will not stop someone with
            access to the disk. Wrong attempts are slowed and then locked out.
          </Alert>
          {lockOn && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
              Lock straight away from File → Lock now (Ctrl+L).
            </Typography>
          )}
        </Paper>
      </Section>

      <Section
        title="Privacy"
        subtitle="Both are off unless you turn them on. Digital Personal Data Protection Act, 2023."
      >
        <Paper variant="outlined" sx={CARD}>
          <FormControlLabel
            control={
              <Switch
                checked={consent?.analytics ?? false}
                onChange={(e) => onConsent(e.target.checked, consent?.cloudSync ?? false)}
              />
            }
            label="Anonymous diagnostics"
          />
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
            Crash reports and error codes only — never amounts, GSTINs or party names.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={consent?.cloudSync ?? false}
                disabled={!signedIn}
                onChange={(e) => onConsent(consent?.analytics ?? false, e.target.checked)}
              />
            }
            label={
              <Stack direction="row" spacing={1} alignItems="center">
                <CloudSyncIcon fontSize="small" />
                <span>Cloud backup</span>
              </Stack>
            }
          />
          <Typography variant="caption" color="text.secondary" display="block">
            Encrypted, compressed backups so your register can be restored on another machine.
          </Typography>
          {!signedIn && (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              Sign in on the Profile page to enable cloud backup. The encryption key is derived from
              your password, so there is nothing to encrypt a backup with until you do.
            </Alert>
          )}

          {consent?.cloudSync && signedIn && (
            <Alert severity="success" sx={{ mt: 2 }}>
              Cloud backup is on. Run and review backups on the Profile page.
            </Alert>
          )}
          {consent && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
              Choices recorded {new Date(consent.decidedAt).toLocaleString()}.
            </Typography>
          )}
        </Paper>
      </Section>

      <Section title="Updates">
        <Paper variant="outlined" sx={CARD}>
          <Stack direction="row" spacing={2} alignItems="center">
            <SystemUpdateAltIcon fontSize="small" color="disabled" />
            <Typography variant="body2">
              Installed: <strong>{info.version}</strong> (build {info.buildCode})
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            Check for updates from Help in the menu bar.
          </Typography>
          {update?.status === 'dev' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Running from a development build — updates do not apply.
            </Alert>
          )}
          {update?.status === 'current' && (
            <Alert severity="success" sx={{ mt: 2 }}>
              You are on the latest version.
            </Alert>
          )}
          {update?.status === 'available' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Version {update.version} is downloading in the background.
            </Alert>
          )}
          {update?.status === 'downloading' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Downloading {update.version} — {update.percent}%
            </Alert>
          )}
          {update?.status === 'ready' && (
            <Alert
              severity="success"
              sx={{ mt: 2 }}
              action={
                <Button size="small" onClick={() => void window.api.updates.install()}>
                  Restart now
                </Button>
              }
            >
              Version {update.version} is ready and will install when you close the app.
            </Alert>
          )}
          {update?.status === 'signin-required' && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Sign in on the Profile page to receive updates.
            </Alert>
          )}
          {update?.status === 'error' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Could not check for updates: {update.detail}
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
            Updates install when you close the app, never in the middle of your work.
          </Typography>
        </Paper>
      </Section>

      {capture && (
        <Lock
          mode={capture === 'set' ? 'set' : 'unlock'}
          onCancel={() => setCapture(null)}
          onUnlocked={async (code) => {
            if (capture === 'set') {
              const result = await window.api.passcode.set(code)
              if (result.ok) {
                setLockOn(true)
                setLockMsg('Passcode set. It will be asked for next time Utility opens.')
              } else {
                setLockMsg(result.error ?? 'Could not set the passcode.')
              }
            } else {
              const result = await window.api.passcode.disable(code)
              if (result.ok) {
                setLockOn(false)
                setLockMsg('Passcode removed.')
              } else {
                setLockMsg(result.error ?? 'That code is not right.')
              }
            }
            setCapture(null)
          }}
        />
      )}
    </Box>
  )
}
