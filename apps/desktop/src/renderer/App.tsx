import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Container, CssBaseline, Fade, Snackbar, Stack, ThemeProvider, Typography,
  useMediaQuery
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DownloadIcon from '@mui/icons-material/Download'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import type { AppInfo, Settings as SettingsShape } from '../preload/index'
import { buildTheme } from './theme'
import {
  Brand,
  ConfirmDialog,
  ConsentBanner,
  FeedbackDialog,
  ShortcutsDialog,
  SignInRequiredDialog,
  UpdateReadyDialog,
  UpdatedDialog,
  ForcePasswordChange,
  SuspendedScreen,
  WhatsNewBanner,
  type ConfirmSpec
} from './ui'
import Invoices from './screens/Invoices'
import History from './screens/History'
import Sheets from './screens/Sheets'
import Account from './screens/Account'
import Network from './screens/Network'
import Dashboard, { type Dest } from './screens/Dashboard'
import Lock from './screens/Lock'
import { AboutDialog, LicencesDialog, SettingsScreen } from './screens/Pages'
import Docs from './screens/Docs'

/**
 * Navigation lives entirely in the native application menu (View, and the
 * Ctrl+1..7 accelerators). There is no in-app rail: duplicating the menu inside
 * the window costs horizontal space that the review grid and the spreadsheet
 * editor both need, and leaves two places for "where am I" to disagree.
 */

type Route = 'dashboard' | 'invoices' | 'history' | 'sheets' | 'network' | 'profile' | 'settings'

const TITLES: Record<Route, string> = {
  dashboard: 'Dashboard',
  invoices: 'Invoices',
  history: 'History',
  sheets: 'Spreadsheets',
  network: 'Local network',
  profile: 'Profile',
  settings: 'Settings'
}

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>('dashboard')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [licencesOpen, setLicencesOpen] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)
  const [updateReady, setUpdateReady] = useState<string | null>(null)
  const [restored, setRestored] = useState<string | null>(null)
  const [suspended, setSuspended] = useState(false)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [updated, setUpdated] = useState<string | null>(null)
  const [needSignIn, setNeedSignIn] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [locked, setLocked] = useState<boolean | null>(null)
  const [whatsNew, setWhatsNew] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(false)

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const mode: 'light' | 'dark' =
    settings?.theme === 'system' || !settings ? (prefersDark ? 'dark' : 'light') : settings.theme
  const theme = useMemo(() => buildTheme(mode), [mode])

  const refreshAuth = useCallback(() => {
    void window.api.auth.status().then((s) => setSignedIn(s.signedIn))
  }, [])

  useEffect(() => {
    void window.api.app.info().then(setInfo)
    void window.api.settings.get().then(setSettings)
    void window.api.passcode.status().then((s) => setLocked(!s.unlocked))
    refreshAuth()
  }, [refreshAuth])

  const confirm = useCallback((spec: ConfirmSpec) => setConfirmSpec(spec), [])

  const patchSettings = useCallback(
    (patch: Partial<Pick<SettingsShape, 'theme' | 'confirmOnExit'>>) => {
      void window.api.settings.patch(patch).then(setSettings)
    },
    []
  )

  const setConsent = useCallback((analytics: boolean, cloudSync: boolean) => {
    void window.api.settings.setConsent(analytics, cloudSync).then(setSettings)
  }, [])

  // Menu intents. The menu never acts directly; it asks the renderer, which owns
  // screen state.
  useEffect(() => {
    const offNav = window.api.menu.onNavigate((next) => setRoute(next as Route))
    const offAction = window.api.menu.onAction((action) => {
      if (action === 'feedback') setFeedbackOpen(true)
      else if (action === 'shortcuts') setShortcutsOpen(true)
      else if (action === 'toggle-theme') {
        void window.api.settings.get().then((current) => {
          void window.api.settings
            .patch({ theme: current.theme === 'dark' ? 'light' : 'dark' })
            .then(setSettings)
        })
      } else if (action === 'reveal-output') void window.api.paths.reveal()
      else if (action === 'lock') void window.api.passcode.lock().then(() => setLocked(true))
      else if (action === 'docs') setDocsOpen(true)
      else if (action === 'about') setAboutOpen(true)
      else if (action === 'licences') setLicencesOpen(true)
      else if (action === 'check-updates') {
        void window.api.updates.check().then((s) => {
          if (s.status === 'signin-required') setNeedSignIn(true)
          else setRoute('settings')
        })
      }
      else if (action === 'import' || action === 'export') setRoute('invoices')
      else if (action === 'open-sheet' || action === 'save-sheet') setRoute('sheets')
    })
    return () => {
      offNav()
      offAction()
    }
  }, [])

  useEffect(() => {
    if (!info) return
    // Shown once per version. The acknowledged version lives in the main
    // process, so clearing renderer storage cannot make it reappear and a
    // reinstall of the same version stays quiet.
    void window.api.whatsNew.seen().then((seen) => {
      if (seen && seen !== info.version) setWhatsNew(info.version)
      else if (!seen) void window.api.whatsNew.ack()
    })
  }, [info])

  useEffect(() => {
    return window.api.updates.onState((state) => {
      if (state.status === 'ready') setUpdateReady(state.version)
    })
  }, [])

  /**
   * Collect a restore an administrator queued for this account.
   *
   * Runs once the lock is cleared, because the restore rewrites the local data
   * files and the operator should be past the door before that happens. It is a
   * no-op when nothing is queued or the machine is offline.
   */
  useEffect(() => {
    if (locked) return
    void window.api.sync.applyQueuedRestore().then((result) => {
      if (result.applied) setRestored(result.name)
    })
  }, [locked])

  /**
   * Account state the server owns: a suspension, or a temporary password that
   * has to be replaced. Re-checked periodically so a lock lifts, or takes
   * effect, without the operator restarting. Offline it reports neither, which
   * keeps an unreachable server from locking an offline-first app.
   */
  const refreshAccountState = useCallback(() => {
    return window.api.sync.accountState().then((state) => {
      setSuspended(state.suspended)
      setMustChangePassword(state.mustChangePassword)
    })
  }, [])

  useEffect(() => {
    if (locked) return
    void refreshAccountState()
    const timer = setInterval(() => void refreshAccountState(), 60000)
    return () => clearInterval(timer)
  }, [locked, refreshAccountState])

  if (locked) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Lock onUnlocked={() => setLocked(false)} />
      </ThemeProvider>
    )
  }

  // A suspension covers everything; a forced password change sits on top of the
  // app so the rest stays visible behind it and the reason is obvious.
  if (suspended) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <SuspendedScreen onRecheck={() => refreshAccountState()} />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default'
        }}
      >
        {mustChangePassword && (
          <ForcePasswordChange onDone={() => setMustChangePassword(false)} />
        )}

        <WhatsNewBanner
          version={whatsNew}
          onDismiss={() => {
            setWhatsNew(null)
            void window.api.whatsNew.ack()
          }}
        />

        {/* A restore replaces the local data files, so it is never silent. */}
        <Snackbar
          open={restored !== null}
          autoHideDuration={12000}
          onClose={() => setRestored(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="success" onClose={() => setRestored(null)} variant="filled">
            Your administrator restored a backup ({restored}). Restart Utility to see the
            restored history and settings.
          </Alert>
        </Snackbar>

        {/* Slim context bar: just says where you are. Theme and feedback live in
            the menu bar so there is one place to look for an action. */}
        <Stack
          direction="row"
          alignItems="center"
          sx={{
            px: 3,
            py: 1.25,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper'
          }}
        >
          {route !== 'dashboard' && (
            <Button
              size="small"
              color="inherit"
              startIcon={<ArrowBackIcon />}
              onClick={() => setRoute('dashboard')}
              sx={{ mr: 1.5 }}
            >
              Back
            </Button>
          )}
          <Typography variant="subtitle2" sx={{ fontWeight: 680, letterSpacing: '-.01em' }}>
            {TITLES[route]}
          </Typography>
          {route === 'invoices' && (
            <>
              <Box sx={{ flexGrow: 1 }} />
              <Button
                size="small"
                variant="contained"
                startIcon={<FolderOpenIcon />}
                onClick={() => window.dispatchEvent(new CustomEvent('utility:action', { detail: 'import' }))}
              >
                Import
              </Button>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                sx={{ ml: 1 }}
                onClick={() => window.dispatchEvent(new CustomEvent('utility:action', { detail: 'export' }))}
              >
                Export register
              </Button>
            </>
          )}
        </Stack>

        <Container maxWidth="xl" sx={{ flexGrow: 1, py: 3.5 }}>
          <Fade in key={route} timeout={240}>
            <Box>
              {route === 'dashboard' && (
                <Dashboard onNavigate={(dest: Dest) => setRoute(dest)} signedIn={signedIn} />
              )}
              {route === 'invoices' && <Invoices confirm={confirm} />}
              {route === 'history' && <History confirm={confirm} />}
              {route === 'sheets' && <Sheets confirm={confirm} />}
              {route === 'network' && <Network confirm={confirm} />}
              {route === 'profile' && (
                <Account
                  cloudEnabled={settings?.consent?.cloudSync === true}
                  onCloudToggle={(on) => setConsent(settings?.consent?.analytics ?? false, on)}
                  onAuthChange={refreshAuth}
                  confirm={confirm}
                />
              )}
              {route === 'settings' && info && (
                <SettingsScreen
                  info={info}
                  settings={settings}
                  signedIn={signedIn}
                  onPatch={patchSettings}
                  onConsent={setConsent}
                />
              )}
            </Box>
          </Fade>
        </Container>

        <Box
          component="footer"
          sx={{ py: 1.5, textAlign: 'center', borderTop: 1, borderColor: 'divider' }}
        >
          <Brand />
          {info && (
            <Typography variant="caption" color="text.secondary">
              {' '}
              · v{info.version}
            </Typography>
          )}
        </Box>
      </Box>

      <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ConsentBanner open={settings?.needsConsent === true} onDecide={setConsent} />
      <LicencesDialog open={licencesOpen} onClose={() => setLicencesOpen(false)} />
      <Docs open={docsOpen} onClose={() => setDocsOpen(false)} />
      {info && (
        <AboutDialog open={aboutOpen} info={info} onClose={() => setAboutOpen(false)} />
      )}
      <UpdateReadyDialog version={updateReady} onClose={() => setUpdateReady(null)} />
      <UpdatedDialog version={updated} onClose={() => setUpdated(null)} />
      <SignInRequiredDialog
        open={needSignIn}
        onClose={() => setNeedSignIn(false)}
        onGoToProfile={() => setRoute('profile')}
      />
    </ThemeProvider>
  )
}
