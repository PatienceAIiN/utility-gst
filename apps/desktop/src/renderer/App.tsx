import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box, Button, Container, CssBaseline, Fade, Stack, ThemeProvider, Typography, useMediaQuery
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
  type ConfirmSpec
} from './ui'
import Invoices from './screens/Invoices'
import History from './screens/History'
import Sheets from './screens/Sheets'
import Account from './screens/Account'
import Network from './screens/Network'
import Dashboard, { type Dest } from './screens/Dashboard'
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
  const [updated, setUpdated] = useState<string | null>(null)
  const [needSignIn, setNeedSignIn] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
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
    // "Updated" is decided by comparing the running version against the last one
    // seen, so it appears exactly once after an update actually applied.
    const key = 'utility.lastSeenVersion'
    const previous = localStorage.getItem(key)
    if (previous && previous !== info.version) setUpdated(info.version)
    localStorage.setItem(key, info.version)
  }, [info])

  useEffect(() => {
    return window.api.updates.onState((state) => {
      if (state.status === 'ready') setUpdateReady(state.version)
    })
  }, [])

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
