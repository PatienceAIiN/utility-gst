import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box, Container, CssBaseline, Divider, Fade, IconButton, List, ListItemButton, ListItemIcon,
  ListItemText, Stack, ThemeProvider, Tooltip, Typography, useMediaQuery
} from '@mui/material'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import HistoryIcon from '@mui/icons-material/History'
import TableChartIcon from '@mui/icons-material/TableChart'
import SettingsIcon from '@mui/icons-material/Settings'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import type { AppInfo, Settings as SettingsShape } from '../preload/index'
import { buildTheme } from './theme'
import { Brand, ConfirmDialog, ConsentBanner, FeedbackDialog, type ConfirmSpec } from './ui'
import Invoices from './screens/Invoices'
import History from './screens/History'
import Sheets from './screens/Sheets'
import Account from './screens/Account'
import { About, SettingsScreen } from './screens/Pages'

type Route = 'invoices' | 'history' | 'sheets' | 'profile' | 'settings' | 'about'

const NAV: { key: Route; label: string; icon: JSX.Element }[] = [
  { key: 'invoices', label: 'Invoices', icon: <ReceiptLongIcon /> },
  { key: 'history', label: 'History', icon: <HistoryIcon /> },
  { key: 'sheets', label: 'Spreadsheets', icon: <TableChartIcon /> },
  { key: 'profile', label: 'Profile', icon: <PersonOutlineIcon /> },
  { key: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  { key: 'about', label: 'About', icon: <InfoOutlinedIcon /> }
]

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>('invoices')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const mode: 'light' | 'dark' =
    settings?.theme === 'system' || !settings ? (prefersDark ? 'dark' : 'light') : settings.theme
  const theme = useMemo(() => buildTheme(mode), [mode])

  useEffect(() => {
    void window.api.app.info().then(setInfo)
    void window.api.settings.get().then(setSettings)
  }, [])

  const confirm = useCallback((spec: ConfirmSpec) => setConfirmSpec(spec), [])

  const patchSettings = useCallback(
    (patch: Partial<Pick<SettingsShape, 'theme' | 'confirmOnExit' | 'serverUrl'>>) => {
      void window.api.settings.patch(patch).then(setSettings)
    },
    []
  )

  const setConsent = useCallback((analytics: boolean, cloudSync: boolean) => {
    void window.api.settings.setConsent(analytics, cloudSync).then(setSettings)
  }, [])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
        {/* Navigation rail */}
        <Box
          component="nav"
          sx={{
            width: 216,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <Box sx={{ px: 2.5, py: 2.5 }}>
            <Typography variant="h6" sx={{ lineHeight: 1.1 }}>
              Utility
            </Typography>
            <Typography variant="caption" color="text.secondary">
              GST Sales Register
            </Typography>
          </Box>
          <Divider />
          <List sx={{ px: 1.25, py: 1.5, flexGrow: 1 }}>
            {NAV.map((item) => (
              <ListItemButton
                key={item.key}
                selected={route === item.key}
                onClick={() => setRoute(item.key)}
                sx={{
                  borderRadius: 2,
                  mb: 0.5,
                  transition: 'background-color 160ms ease',
                  '&.Mui-selected': { bgcolor: 'action.selected' }
                }}
              >
                <ListItemIcon sx={{ minWidth: 38, color: route === item.key ? 'primary.main' : 'inherit' }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{
                    variant: 'body2',
                    fontWeight: route === item.key ? 650 : 500
                  }}
                />
              </ListItemButton>
            ))}
          </List>
          <Divider />
          <Stack direction="row" alignItems="center" sx={{ px: 1.5, py: 1 }}>
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
                {mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        {/* Content */}
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Container maxWidth="xl" sx={{ flexGrow: 1, py: 4 }}>
            <Fade in key={route} timeout={240}>
              <Box>
                {route === 'invoices' && <Invoices confirm={confirm} />}
                {route === 'history' && <History confirm={confirm} />}
                {route === 'sheets' && <Sheets confirm={confirm} />}
                {route === 'profile' && (
                  <Account
                    cloudEnabled={settings?.consent?.cloudSync === true}
                    onCloudToggle={(on) => setConsent(settings?.consent?.analytics ?? false, on)}
                    confirm={confirm}
                  />
                )}
                {route === 'settings' && info && (
                  <SettingsScreen
                    info={info}
                    settings={settings}
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
      </Box>

      <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <ConsentBanner open={settings?.needsConsent === true} onDecide={setConsent} />
    </ThemeProvider>
  )
}
