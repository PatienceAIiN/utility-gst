import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  IconButton, InputAdornment, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TextField, Tooltip, Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import RestoreIcon from '@mui/icons-material/Restore'
import DownloadIcon from '@mui/icons-material/Download'
import EditIcon from '@mui/icons-material/Edit'
import VisibilityIcon from '@mui/icons-material/Visibility'
import type { HistoryPage, HistoryRecord } from '../../preload/index'
import { Busy, EmptyState, Section, type ConfirmSpec } from '../ui'

/**
 * Every file ever processed, paginated, with view / edit / download / delete.
 * Delete is a soft delete with an audit trail -- financial records are never
 * hard-deleted (brief §8).
 */

const money = (value: string | null): string =>
  value == null || value === ''
    ? '—'
    : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function History({
  confirm
}: {
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [query, setQuery] = useState('')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<HistoryRecord | null>(null)
  const [editing, setEditing] = useState<HistoryRecord | null>(null)
  const [draft, setDraft] = useState({ invoiceNo: '', party: '', note: '' })

  const refresh = useCallback(async () => {
    setBusy('Loading…')
    try {
      setPage(
        await window.api.history.list({
          page: pageIndex + 1,
          pageSize,
          query,
          includeDeleted
        })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load history')
    } finally {
      setBusy(null)
    }
  }, [pageIndex, pageSize, query, includeDeleted])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Section
      title="History"
      subtitle="Every file processed on this machine. Deleting keeps an auditable record."
      action={
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={includeDeleted}
              onChange={(e) => {
                setIncludeDeleted(e.target.checked)
                setPageIndex(0)
              }}
            />
          }
          label={<Typography variant="body2">Show deleted</Typography>}
        />
      }
    >
      <Busy show={busy !== null} label={busy ?? undefined} />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <TextField
        size="small"
        fullWidth
        placeholder="Search by file, invoice number, party or GSTIN"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setPageIndex(0)
        }}
        sx={{ mb: 2, maxWidth: 480 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          )
        }}
      />

      {page && page.total === 0 ? (
        <EmptyState
          title={query ? 'Nothing matches that search' : 'Nothing processed yet'}
          body={
            query
              ? 'Try a different invoice number, party name or file name.'
              : 'Files you import will be listed here with their totals, so you can find, re-export or remove them later.'
          }
        />
      ) : (
        <Paper variant="outlined">
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Invoice', 'Date', 'Party', 'Rows', 'Taxable', 'Grand total', 'Status', ''].map((h) => (
                    <TableCell key={h} align={['Rows', 'Taxable', 'Grand total'].includes(h) ? 'right' : 'left'}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {page?.items.map((record) => (
                  <TableRow key={record.id} hover sx={{ opacity: record.deletedAt ? 0.55 : 1 }}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {record.invoiceNo ?? '—'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {record.sourceFile}
                      </Typography>
                    </TableCell>
                    <TableCell>{record.invoiceDate ?? '—'}</TableCell>
                    <TableCell>
                      <Typography variant="body2" noWrap sx={{ maxWidth: 220 }}>
                        {record.party ?? '—'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {record.gstin ?? ''}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{record.rows}</TableCell>
                    <TableCell align="right">{money(record.taxable)}</TableCell>
                    <TableCell align="right">{money(record.grandTotal)}</TableCell>
                    <TableCell>
                      {record.deletedAt ? (
                        <Chip size="small" label="Deleted" />
                      ) : record.blocked ? (
                        <Chip size="small" color="error" label="Needs review" />
                      ) : (
                        <Chip size="small" color="success" label="Ties out" />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" justifyContent="flex-end">
                        <Tooltip title="View">
                          <IconButton size="small" onClick={() => setViewing(record)}>
                            <VisibilityIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <span>
                            <IconButton
                              size="small"
                              disabled={Boolean(record.deletedAt)}
                              onClick={() => {
                                setEditing(record)
                                setDraft({
                                  invoiceNo: record.invoiceNo ?? '',
                                  party: record.party ?? '',
                                  note: record.note ?? ''
                                })
                              }}
                            >
                              <EditIcon fontSize="inherit" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Re-export register">
                          <span>
                            <IconButton
                              size="small"
                              disabled={Boolean(record.deletedAt) || busy !== null}
                              onClick={async () => {
                                setBusy('Re-exporting…')
                                setError(null)
                                try {
                                  const result = await window.api.history.download(record.id)
                                  if (result) {
                                    setNotice(`Written to ${result.path}`)
                                    await refresh()
                                  }
                                } catch (e) {
                                  setError(e instanceof Error ? e.message : 'Export failed')
                                } finally {
                                  setBusy(null)
                                }
                              }}
                            >
                              <DownloadIcon fontSize="inherit" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        {record.deletedAt ? (
                          <Tooltip title="Restore">
                            <IconButton
                              size="small"
                              onClick={async () => {
                                await window.api.history.restore(record.id)
                                await refresh()
                              }}
                            >
                              <RestoreIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Delete">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() =>
                                confirm({
                                  title: 'Delete this record?',
                                  body: `${record.invoiceNo ?? record.sourceFile} will be hidden from the list. Accounting records are never permanently erased — it stays in the audit trail and can be restored.`,
                                  confirmLabel: 'Delete',
                                  destructive: true,
                                  onConfirm: async () => {
                                    await window.api.history.remove(record.id)
                                    await refresh()
                                  }
                                })
                              }
                            >
                              <DeleteOutlineIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={page?.total ?? 0}
            page={pageIndex}
            onPageChange={(_e, p) => setPageIndex(p)}
            rowsPerPage={pageSize}
            onRowsPerPageChange={(e) => {
              setPageSize(Number(e.target.value))
              setPageIndex(0)
            }}
            rowsPerPageOptions={[10, 25, 50, 100]}
          />
        </Paper>
      )}

      {/* View */}
      <Dialog open={viewing !== null} onClose={() => setViewing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{viewing?.invoiceNo ?? viewing?.sourceFile}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.25}>
            {(
              [
                ['Source file', viewing?.sourceFile],
                ['Processed', viewing ? new Date(viewing.parsedAt).toLocaleString() : ''],
                ['Party', viewing?.party],
                ['GSTIN', viewing?.gstin],
                ['Supply', viewing?.supplyType === 'intra' ? 'CGST + SGST' : viewing?.supplyType === 'inter' ? 'IGST' : '—'],
                ['Register rows', String(viewing?.rows ?? '')],
                ['Taxable', money(viewing?.taxable ?? null)],
                ['Tax', money(viewing?.taxTotal ?? null)],
                ['Grand total', money(viewing?.grandTotal ?? null)],
                ['Difference', money(viewing?.tieOutDelta ?? null)],
                ['Checksum', viewing?.sha256?.slice(0, 24) + '…'],
                ['Last export', viewing?.exportPath ?? 'Not exported'],
                ['Note', viewing?.note ?? '—']
              ] as [string, string | null | undefined][]
            ).map(([label, value]) => (
              <Stack key={label} direction="row" spacing={2}>
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 130 }}>
                  {label}
                </Typography>
                <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                  {value || '—'}
                </Typography>
              </Stack>
            ))}
            {viewing?.warnings.length ? (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {viewing.warnings.join(', ')}
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setViewing(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Edit */}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit record</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Alert severity="info">
              Editing these fields changes the record only. The source file and the computed
              amounts are not altered, and the change is written to the audit trail.
            </Alert>
            <TextField
              label="Invoice number"
              size="small"
              value={draft.invoiceNo}
              onChange={(e) => setDraft({ ...draft, invoiceNo: e.target.value })}
            />
            <TextField
              label="Party name"
              size="small"
              value={draft.party}
              onChange={(e) => setDraft({ ...draft, party: e.target.value })}
            />
            <TextField
              label="Note"
              multiline
              minRows={3}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={async () => {
              if (editing) {
                await window.api.history.update(editing.id, draft)
                setEditing(null)
                await refresh()
                setNotice('Record updated')
              }
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}
