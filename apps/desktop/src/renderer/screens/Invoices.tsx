import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Chip, Divider, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Typography
} from '@mui/material'
import type { ConfirmSpec } from '../ui'
import { Busy, EmptyState, Section } from '../ui'

interface Finding {
  rule_code: string
  severity: 'blocking' | 'warning' | 'info'
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
export interface Invoice {
  source_file: string
  invoice_no: string | null
  invoice_date: string | null
  buyer_name: string | null
  buyer_gstin: string | null
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

export default function Invoices({
  confirm
}: {
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [paths, setPaths] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const blocked = invoices.some((i) => i.is_blocked)
  const rowCount = invoices.reduce((n, i) => n + i.line_items.length, 0)

  async function pickAndParse(): Promise<void> {
    setError(null)
    setExported(null)
    const picked = await window.api.files.pick()
    if (picked.length === 0) return
    setBusy(`Reading ${picked.length} file(s)…`)
    try {
      setInvoices((await window.api.invoice.parse(picked)) as Invoice[])
      setPaths(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed')
    } finally {
      setBusy(null)
    }
  }

  async function runExport(): Promise<void> {
    setError(null)
    if (paths.length === 0) return
    setBusy('Writing the register…')
    try {
      const result = await window.api.export.run(paths, '')
      setExported(result.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(null)
    }
  }

  // File menu drives import and export; this screen shows the result.
  useEffect(() => {
    const fromMenu = window.api.menu.onAction((action) => {
      if (action === 'import') void pickAndParse()
      else if (action === 'export') void runExport()
    })
    // The bar buttons raise the same intents, so there is one code path whether
    // the operator uses the menu or the button.
    const fromBar = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail
      if (detail === 'import') void pickAndParse()
      else if (detail === 'export') void runExport()
    }
    window.addEventListener('utility:action', fromBar)
    return () => {
      fromMenu()
      window.removeEventListener('utility:action', fromBar)
    }
  })

  return (
    <Section
      title=""
      action={
        invoices.length > 0 ? (
          <Button
            color="inherit"
            onClick={() =>
              confirm({
                title: 'Clear imported invoices?',
                body: 'Removes them from this screen. The source files are not touched.',
                confirmLabel: 'Clear',
                destructive: true,
                onConfirm: () => {
                  setInvoices([])
                  setPaths([])
                  setExported(null)
                }
              })
            }
          >
            Clear
          </Button>
        ) : undefined
      }
    >
      <Busy show={busy !== null} label={busy ?? undefined} />

      {invoices.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {invoices.length} invoice(s) · {rowCount} register rows
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {exported && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          action={
            <Button size="small" onClick={() => void window.api.shell.showItem(exported)}>
              Show file
            </Button>
          }
        >
          Register written to {exported}
        </Alert>
      )}
      {blocked && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Export is disabled while any invoice has a blocking failure. Wrong data must never reach
          the register silently.
        </Alert>
      )}

      {invoices.length === 0 && busy === null && (
        <EmptyState
          title="No invoices loaded"
          body="Use File → Import invoices (Ctrl+O) to begin. Every file is read, checked and reconciled on this computer — nothing is uploaded. When the figures tie out, File → Export register (Ctrl+E) writes the register to your Utility folder."
        />
      )}

      {invoices.map((invoice) => (
        <Paper key={invoice.source_file} variant="outlined" sx={{ mb: 3, overflow: 'hidden' }}>
          <Box sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1" fontWeight={620}>
                {invoice.invoice_no ?? invoice.source_file}
              </Typography>
              {invoice.invoice_date && <Chip size="small" label={invoice.invoice_date} />}
              {invoice.supply_type && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={invoice.supply_type === 'intra' ? 'CGST + SGST' : 'IGST'}
                />
              )}
              <Chip
                size="small"
                color={invoice.is_blocked ? 'error' : 'success'}
                label={invoice.is_blocked ? 'Needs review' : 'Ties out'}
              />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {invoice.buyer_name} · {invoice.buyer_gstin}
            </Typography>
          </Box>

          {invoice.error && <Alert severity="error">{invoice.error}</Alert>}
          {invoice.findings.map((finding, index) => (
            <Alert
              key={index}
              severity={
                finding.severity === 'blocking'
                  ? 'error'
                  : finding.severity === 'info'
                    ? 'info'
                    : 'warning'
              }
              sx={{ borderRadius: 0 }}
            >
              {finding.message}
              {finding.src_line ? ` (line ${finding.src_line})` : ''}
            </Alert>
          ))}

          {invoice.line_items.length > 0 && (
            <TableContainer sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {['#', 'Description', 'HSN', 'Qty', 'Rate', 'GST%', 'Taxable', 'IGST', 'CGST', 'SGST', 'Total'].map(
                      (h) => (
                        <TableCell key={h} align={h === 'Description' ? 'left' : 'right'}>
                          {h}
                        </TableCell>
                      )
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {invoice.line_items.map((item) => (
                    <TableRow key={item.src_line} hover>
                      <TableCell align="right">{item.src_line}</TableCell>
                      <TableCell>{item.description}</TableCell>
                      <TableCell align="right">
                        <code>{item.hsn}</code>
                      </TableCell>
                      <TableCell align="right">{item.qty}</TableCell>
                      <TableCell align="right">{money(item.unit_rate)}</TableCell>
                      <TableCell align="right">{item.gst_rate}%</TableCell>
                      <TableCell align="right">{money(item.taxable)}</TableCell>
                      <TableCell align="right">{money(item.igst)}</TableCell>
                      <TableCell align="right">{money(item.cgst)}</TableCell>
                      <TableCell align="right">{money(item.sgst)}</TableCell>
                      <TableCell align="right">
                        <strong>{money(item.line_total)}</strong>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Divider />
          <Box sx={{ p: 2, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {(
              [
                ['Taxable', invoice.totals['taxable']],
                ['CGST', invoice.totals['cgst']],
                ['SGST', invoice.totals['sgst']],
                ['IGST', invoice.totals['igst']],
                ['Round off', invoice.round_off],
                ['Grand total', invoice.totals['computed_grand_total']],
                ['Invoice says', invoice.stated_grand_total],
                ['Difference', invoice.totals['tie_out_delta']]
              ] as [string, string | null][]
            ).map(([label, value]) => (
              <Box key={label}>
                <Typography variant="caption" color="text.secondary">
                  {label}
                </Typography>
                <Typography
                  variant="body2"
                  fontWeight={620}
                  color={label === 'Difference' && value !== '0.00' ? 'error.main' : 'text.primary'}
                >
                  {money(value)}
                </Typography>
              </Box>
            ))}
          </Box>
        </Paper>
      ))}
    </Section>
  )
}
