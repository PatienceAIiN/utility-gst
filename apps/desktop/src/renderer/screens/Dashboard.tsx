import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, Grid, Paper, Stack, Typography } from '@mui/material'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import HistoryIcon from '@mui/icons-material/History'
import TableChartIcon from '@mui/icons-material/TableChart'
import LanIcon from '@mui/icons-material/Lan'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import SettingsIcon from '@mui/icons-material/Settings'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import type { HistoryRecord } from '../../preload/index'

/**
 * Landing screen. Shows what state the register is actually in -- how much has
 * been processed, what is waiting on review, whether anything failed to tie out
 * -- rather than a wall of shortcuts. Counts come from the signed-in user's own
 * records only.
 */

export type Dest = 'invoices' | 'history' | 'sheets' | 'network' | 'profile' | 'settings'

const money = (value: string | null | undefined): string =>
  value == null || value === ''
    ? '—'
    : `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

const TILES: { key: Dest; label: string; hint: string; icon: JSX.Element }[] = [
  { key: 'invoices', label: 'Invoices', hint: 'Import and check invoices', icon: <ReceiptLongIcon /> },
  { key: 'history', label: 'History', hint: 'Everything processed', icon: <HistoryIcon /> },
  { key: 'sheets', label: 'Spreadsheets', hint: 'Open and edit CSV or Excel', icon: <TableChartIcon /> },
  { key: 'network', label: 'Local network', hint: 'Share with this office', icon: <LanIcon /> },
  { key: 'profile', label: 'Profile', hint: 'Account and backup', icon: <PersonOutlineIcon /> },
  { key: 'settings', label: 'Settings', hint: 'Folders, theme, privacy', icon: <SettingsIcon /> }
]

export default function Dashboard({
  onNavigate,
  signedIn
}: {
  onNavigate: (dest: Dest) => void
  signedIn: boolean
}): JSX.Element {
  const [items, setItems] = useState<HistoryRecord[]>([])
  const [total, setTotal] = useState(0)

  const load = useCallback(async () => {
    const page = await window.api.history.list({ page: 1, pageSize: 200 })
    setItems(page.items)
    setTotal(page.total)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = items.reduce((n, r) => n + r.rows, 0)
  const needsReview = items.filter((r) => r.blocked).length
  const outOfBalance = items.filter((r) => r.tieOutDelta && Number(r.tieOutDelta) !== 0).length
  const taxable = items
    .reduce((sum, r) => sum + Number(r.taxable ?? 0), 0)
    .toFixed(2)

  const stats: { label: string; value: string; tone?: 'error' | 'warning' }[] = [
    { label: 'Invoices processed', value: String(total) },
    { label: 'Register rows', value: String(rows) },
    { label: 'Taxable value', value: money(taxable) },
    ...(needsReview > 0
      ? [{ label: 'Need review', value: String(needsReview), tone: 'error' as const }]
      : []),
    ...(outOfBalance > 0
      ? [{ label: 'Do not tie out', value: String(outOfBalance), tone: 'warning' as const }]
      : [])
  ]

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        Welcome back
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {total === 0
          ? 'Nothing processed yet. Import invoices to begin — everything happens on this computer.'
          : `${total} invoice${total === 1 ? '' : 's'} processed on this computer.`}
      </Typography>

      <Grid container spacing={2} sx={{ mb: 4 }}>
        {stats.map((stat) => (
          <Grid item xs={6} sm={4} md={2.4} key={stat.label}>
            <Paper variant="outlined" sx={{ p: 2.25 }}>
              <Typography
                variant="h5"
                sx={{ fontWeight: 680, letterSpacing: '-.02em' }}
                color={stat.tone ? `${stat.tone}.main` : 'text.primary'}
              >
                {stat.value}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {stat.label}
              </Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Stack direction="row" spacing={1} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
        <Button
          variant="contained"
          startIcon={<FolderOpenIcon />}
          onClick={() => {
            onNavigate('invoices')
            // Let the screen mount before asking it to open the picker.
            setTimeout(
              () => window.dispatchEvent(new CustomEvent('utility:action', { detail: 'import' })),
              60
            )
          }}
        >
          Import invoices
        </Button>
        {!signedIn && (
          <Button onClick={() => onNavigate('profile')}>Sign in for backup and updates</Button>
        )}
      </Stack>

      <Grid container spacing={2}>
        {TILES.map((tile) => (
          <Grid item xs={12} sm={6} md={4} key={tile.key}>
            <Paper
              variant="outlined"
              onClick={() => onNavigate(tile.key)}
              sx={{
                p: 2.5,
                cursor: 'pointer',
                transition: 'transform 150ms ease, border-color 150ms ease',
                '&:hover': { transform: 'translateY(-2px)', borderColor: 'primary.main' }
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ color: 'primary.main', display: 'flex' }}>{tile.icon}</Box>
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="subtitle2">{tile.label}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {tile.hint}
                  </Typography>
                </Box>
                {tile.key === 'history' && total > 0 && <Chip size="small" label={total} />}
                {tile.key === 'invoices' && needsReview > 0 && (
                  <Chip size="small" color="error" label={needsReview} />
                )}
              </Stack>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Box>
  )
}
