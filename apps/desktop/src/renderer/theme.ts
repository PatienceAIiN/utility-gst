import { createTheme, type Theme } from '@mui/material'

/**
 * Material Design 3 palette, both modes fully specified (brief §8).
 * Motion is defined once here so screens animate consistently.
 */

const shared = {
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: '"Segoe UI Variable", "Segoe UI", Inter, Roboto, system-ui, sans-serif',
    h5: { fontWeight: 650, letterSpacing: '-0.02em' },
    h6: { fontWeight: 620, letterSpacing: '-0.01em' },
    subtitle2: { fontWeight: 600 },
    button: { textTransform: 'none' as const, fontWeight: 600 }
  },
  transitions: {
    duration: { shortest: 120, shorter: 180, short: 220, standard: 280 }
  }
}

export function buildTheme(mode: 'light' | 'dark'): Theme {
  const dark = mode === 'dark'
  return createTheme({
    ...shared,
    palette: {
      mode,
      primary: { main: dark ? '#8ab4ff' : '#0b57d0' },
      secondary: { main: dark ? '#7ad1a8' : '#0f7a4d' },
      error: { main: dark ? '#ff8a80' : '#b3261e' },
      warning: { main: dark ? '#ffcf70' : '#8a5a00' },
      success: { main: dark ? '#7ad1a8' : '#0f7a4d' },
      background: dark
        ? { default: '#0d1117', paper: '#151b23' }
        : { default: '#f7f9fc', paper: '#ffffff' },
      divider: dark ? 'rgba(255,255,255,0.10)' : 'rgba(16,24,40,0.10)'
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' }
        }
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 10,
            paddingInline: 16,
            transition: 'transform 140ms ease, background-color 180ms ease',
            '&:active': { transform: 'scale(0.985)' }
          }
        }
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,40,0.08)' },
          head: { fontWeight: 650, whiteSpace: 'nowrap' }
        }
      },
      MuiTooltip: {
        defaultProps: { arrow: true }
      },
      MuiDialog: {
        styleOverrides: { paper: { borderRadius: 18 } }
      }
    }
  })
}
