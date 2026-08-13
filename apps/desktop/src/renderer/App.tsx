import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box, Chip, Container, CssBaseline, Fade, IconButton, Stack, ThemeProvider, Tooltip, Typography,
  useMediaQuery
} from '@mui/material'
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import type { AppInfo, Settings as SettingsShape } from '../preload/index'
import { buildTheme } from './theme'
import {
  Brand,
  ConfirmDialog,
  ConsentBanner,
  FeedbackDialog,
  ShortcutsDialog,
  type ConfirmSpec
} from './ui'
import Invoices from './screens/Invoices'
import History from './screens/History'
import Sheets from './screens/Sheets'
import Account from './screens/Account'
import Network from './screens/Network'
import { About, SettingsScreen } from './screens/Pages'

/**
 * Navigation lives entirely in the native application menu (View, and the
 * Ctrl+1..7 accelerators). There is no in-app rail: duplicating the menu inside
 * the window costs horizontal space that the review grid and the spreadsheet
 * editor both need, and leaves two places for "where am I" to disagree.
 */

type Route = 'invoices' | 'history' | 'sheets' | 'network' | 'profile' | 'settings' | 'about'

const TITLES: Record<Route, string> = {
  invoices: 'Invoices',
  history: 'History',
  sheets: 'Spreadsheets',
  network: 'Local network',
  profile: 'Profile',
  settings: 'Settings',
  about: 'About'
}

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>('invoices')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
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
      else if (action === 'import' || action === 'export') setRoute('invoices')
      else if (action === 'open-sheet' || action === 'save-sheet') setRoute('sheets')
      else if (action === 'licences') setRoute('settings')
    })
    return () => {
      offNav()
      offAction()
    }
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
        {/* Slim context bar: says where you are without repeating the menu. */}
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{
            px: 3,
            py: 1.25,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper'
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 680, letterSpacing: '-.01em' }}>
            {TITLES[route]}
          </Typography>
          <Chip size="small" variant="outlined" label="View menu · Ctrl 1–7" />
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="Send feedback">
            <IconButton size="small" onClick={() => setFeedbackOpen(true)}>
              <FeedbackOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={mode === 'dark' ? 'Light theme' : 'Dark theme'}>
            <IconButton
              size="small"
              onClick={() => patchSettings({ theme: mode === 'dark' ? 'light' : 'dark' })}
            >
              {mode === 'dark' ? (
                <LightModeIcon fontSize="small" />
              ) : (
                <DarkModeIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Stack>

        <Container maxWidth="xl" sx={{ flexGrow: 1, py: 3.5 }}>
          <Fade in key={route} timeout={240}>
            <Box>
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
              {route === 'about' && info && <About info={info} />}
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
              · v{info.version} (build {info.buildCode})
            </Typography>
          )}
        </Box>
      </Box>

      <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ConsentBanner open={settings?.needsConsent === true} onDecide={setConsent} />
    </ThemeProvider>
  )
}
