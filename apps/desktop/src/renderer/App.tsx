import { useEffect, useMemo, useState } from 'react'
import {
  Alert, AppBar, Box, Button, Chip, CircularProgress, Container, CssBaseline, Divider,
  IconButton, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, ThemeProvider, Toolbar, Tooltip, Typography, createTheme
} from '@mui/material'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DownloadIcon from '@mui/icons-material/Download'

/** Pure IPC consumer. No Electron API, no filesystem, no DB access (brief §3). */

interface Finding {
  rule_code: string
  severity: 'blocking' | 'warning'
  message: string
  src_line: number | null
}
interface LineItem {
  src_line: number
  description: string
  hsn: string | null
  qty: string
  unit: string | null
  unit_rate: string
  gst_rate: string
  taxable: string
  igst: string | null
  cgst: string | null
  sgst: string | null
  line_total: string
}
interface Invoice {
  source_file: string
  invoice_no: string | null
  invoice_date: string | null
  buyer_name: string | null
  buyer_gstin: string | null
  seller_gstin: string | null
  supply_type: string | null
  round_off: string
  stated_grand_total: string | null
  skipped_zero_qty: number[]
  totals: Record<string, string | null>
  line_items: LineItem[]
  findings: Finding[]
  is_blocked: boolean
  error?: string
}

const money = (value: string | null | undefined): string =>
  value == null || value === ''
    ? '—'
    : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function App(): JSX.Element {
  const [dark, setDark] = useState(true)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [paths, setPaths] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState({ version: '…', channel: '…', buildCode: '…' })
  const [exported, setExported] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.app.info().then(setInfo)
  }, [])

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: dark ? 'dark' : 'light',
          primary: { main: dark ? '#9ecaff' : '#0b57d0' },
          background: dark
            ? { default: '#111418', paper: '#1a1f24' }
            : { default: '#f6f8fb', paper: '#ffffff' }
        },
        shape: { borderRadius: 12 },
        typography: { fontFamily: 'Segoe UI, Roboto, system-ui, sans-serif' }
      }),
    [dark]
  )

  const blocked = invoices.some((i) => i.is_blocked)
  const rowCount = invoices.reduce((n, i) => n + i.line_items.length, 0)

  async function pickAndParse(): Promise<void> {
    setError(null)
    setExported(null)
    const picked = await window.api.files.pick()
    if (picked.length === 0) return
    setBusy(true)
    try {
      const parsed = (await window.api.invoice.parse(picked)) as Invoice[]
      setInvoices(parsed)
      setPaths(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed')
    } finally {
      setBusy(false)
    }
  }

  async function runExport(): Promise<void> {
    setError(null)
    const dir = await window.api.export.pickDir()
    if (!dir) return
    setBusy(true)
    try {
      const result = await window.api.export.run(paths, dir)
      setExported(result.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppBar position="static" color="transparent" elevation={0}
          sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar>
            <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
              Utility <Typography component="span" variant="body2" color="text.secondary">
                · GST Sales Register</Typography>
            </Typography>
            <Chip size="small" label={info.channel} sx={{ mr: 1 }} />
            <IconButton onClick={() => setDark(!dark)} aria-label="Toggle theme">
              {dark ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Toolbar>
        </AppBar>

        <Container maxWidth="xl" sx={{ flexGrow: 1, py: 3 }}>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
            <Button variant="contained" startIcon={<FolderOpenIcon />}
              onClick={() => void pickAndParse()} disabled={busy}>
              Import invoices
            </Button>
            <Tooltip title={blocked ? 'Fix the blocking failures first' : ''}>
              <span>
                <Button variant="outlined" startIcon={<DownloadIcon />}
                  onClick={() => void runExport()}
                  disabled={busy || invoices.length === 0 || blocked}>
                  Export register
                </Button>
              </span>
            </Tooltip>
            {busy && <CircularProgress size={22} />}
            {invoices.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                {invoices.length} invoice(s) · {rowCount} register rows
              </Typography>
            )}
          </Stack>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {exported && (
            <Alert severity="success" sx={{ mb: 2 }}
              action={<Button size="small" onClick={() => void window.api.shell.showItem(exported)}>
                Show file</Button>}>
              Register written to {exported}
            </Alert>
          )}
          {blocked && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Export is disabled while any invoice has a blocking failure. Wrong data must never
              reach the Excel silently.
            </Alert>
          )}

          {invoices.length === 0 && !busy && (
            <Paper variant="outlined" sx={{ p: 6, textAlign: 'center', borderStyle: 'dashed' }}>
              <Typography variant="h6" gutterBottom>No invoices loaded</Typography>
              <Typography variant="body2" color="text.secondary">
                Import one or more invoice PDFs. Every file is parsed, validated and reconciled
                locally — nothing is uploaded.
              </Typography>
            </Paper>
          )}

          {invoices.map((invoice) => (
            <Paper key={invoice.source_file} variant="outlined" sx={{ mb: 3, overflow: 'hidden' }}>
              <Box sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="subtitle1" fontWeight={600}>
                    {invoice.invoice_no ?? invoice.source_file}
                  </Typography>
                  {invoice.invoice_date && <Chip size="small" label={invoice.invoice_date} />}
                  {invoice.supply_type && (
                    <Chip size="small" color="primary" variant="outlined"
                      label={invoice.supply_type === 'intra' ? 'Intra-state (CGST+SGST)' : 'Inter-state (IGST)'} />
                  )}
                  <Chip size="small"
                    color={invoice.is_blocked ? 'error' : 'success'}
                    label={invoice.is_blocked ? 'Blocked' : 'Ties out'} />
                  {invoice.skipped_zero_qty.length > 0 && (
                    <Chip size="small" variant="outlined"
                      label={`${invoice.skipped_zero_qty.length} zero-qty lines skipped`} />
                  )}
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {invoice.buyer_name} · {invoice.buyer_gstin}
                </Typography>
              </Box>

              {invoice.error && <Alert severity="error">{invoice.error}</Alert>}

              {invoice.findings.map((finding, index) => (
                <Alert key={index} severity={finding.severity === 'blocking' ? 'error' : 'warning'}
                  sx={{ borderRadius: 0 }}>
                  <strong>{finding.rule_code}</strong>
                  {finding.src_line ? ` (line ${finding.src_line})` : ''} — {finding.message}
                </Alert>
              ))}

              {invoice.line_items.length > 0 && (
                <TableContainer sx={{ maxHeight: 420 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {['#', 'Description', 'HSN', 'Qty', 'Rate', 'GST%', 'Taxable',
                          'IGST', 'CGST', 'SGST', 'Total'].map((h) => (
                          <TableCell key={h} align={h === 'Description' ? 'left' : 'right'}>
                            {h}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {invoice.line_items.map((item) => (
                        <TableRow key={item.src_line} hover>
                          <TableCell align="right">{item.src_line}</TableCell>
                          <TableCell>{item.description}</TableCell>
                          <TableCell align="right"><code>{item.hsn}</code></TableCell>
                          <TableCell align="right">{item.qty}</TableCell>
                          <TableCell align="right">{money(item.unit_rate)}</TableCell>
                          <TableCell align="right">{item.gst_rate}%</TableCell>
                          <TableCell align="right">{money(item.taxable)}</TableCell>
                          <TableCell align="right">{money(item.igst)}</TableCell>
                          <TableCell align="right">{money(item.cgst)}</TableCell>
                          <TableCell align="right">{money(item.sgst)}</TableCell>
                          <TableCell align="right"><strong>{money(item.line_total)}</strong></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}

              <Divider />
              <Box sx={{ p: 2, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                {[['Taxable', invoice.totals['taxable']], ['CGST', invoice.totals['cgst']],
                  ['SGST', invoice.totals['sgst']], ['IGST', invoice.totals['igst']],
                  ['Round off', invoice.round_off], ['Grand total', invoice.totals['computed_grand_total']],
                  ['Invoice says', invoice.stated_grand_total], ['Tie-out delta', invoice.totals['tie_out_delta']]
                ].map(([label, value]) => (
                  <Box key={label as string}>
                    <Typography variant="caption" color="text.secondary">{label}</Typography>
                    <Typography variant="body2" fontWeight={600}
                      color={label === 'Tie-out delta' && value !== '0.00' ? 'error.main' : 'text.primary'}>
                      {money(value as string)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Paper>
          ))}
        </Container>

        <Box component="footer"
          sx={{ py: 1.5, textAlign: 'center', borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary">
            a product of Patience AI · v{info.version} (build {info.buildCode})
          </Typography>
        </Box>
      </Box>
    </ThemeProvider>
  )
}
