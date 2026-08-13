import { useCallback, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Chip, Divider, IconButton, Paper, Stack, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import SaveIcon from '@mui/icons-material/Save'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import UndoIcon from '@mui/icons-material/Undo'
import type { SheetDoc } from '../../preload/index'
import { Busy, EmptyState, Section, type ConfirmSpec } from '../ui'

/**
 * Spreadsheet viewer/editor. Values are edited and saved as text throughout:
 * re-inferring types would strip HSN leading zeros and reinterpret dd-mm-yyyy
 * as US dates, both silently.
 */

const columnLabel = (index: number): string => {
  let label = ''
  let n = index
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

export default function Sheets({
  confirm
}: {
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [doc, setDoc] = useState<SheetDoc | null>(null)
  const [active, setActive] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sheet = doc?.sheets[active]
  const width = useMemo(
    () => Math.max(1, ...(sheet?.rows.map((r) => r.length) ?? [1])),
    [sheet]
  )

  const mutate = useCallback(
    (fn: (rows: string[][]) => string[][]) => {
      setDoc((current) => {
        if (!current) return current
        const sheets = current.sheets.map((s, i) =>
          i === active ? { ...s, rows: fn(s.rows.map((r) => [...r])) } : s
        )
        return { ...current, sheets }
      })
      setDirty(true)
      setSaved(null)
    },
    [active]
  )

  async function open(): Promise<void> {
    setError(null)
    const path = await window.api.sheet.pick()
    if (!path) return
    setBusy('Opening…')
    try {
      const loaded = await window.api.sheet.read(path)
      setDoc(loaded)
      setActive(0)
      setDirty(false)
      setSaved(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the file')
    } finally {
      setBusy(null)
    }
  }

  async function save(overwrite: boolean): Promise<void> {
    if (!doc) return
    setBusy(overwrite ? 'Overwriting…' : 'Saving a copy…')
    setError(null)
    try {
      const result = await window.api.sheet.write(doc.path, doc.sheets, overwrite, doc.delimiter)
      setSaved(result.path)
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="Spreadsheets"
      subtitle="Open, edit and save CSV or Excel files without leaving the app."
      action={
        <Stack direction="row" spacing={1}>
          <Button startIcon={<FolderOpenIcon />} onClick={() => void open()} disabled={busy !== null}>
            Open
          </Button>
          <Button
            startIcon={<SaveIcon />}
            variant="contained"
            disabled={!doc || busy !== null}
            onClick={() => void save(false)}
          >
            Save a copy
          </Button>
          <Tooltip title={doc ? 'Replaces the original file' : ''}>
            <span>
              <Button
                color="warning"
                disabled={!doc || busy !== null}
                onClick={() =>
                  confirm({
                    title: 'Overwrite the original?',
                    body: `This replaces ${doc?.path} in place. If this file is the source for an already-imported invoice, the original will be gone.`,
                    confirmLabel: 'Overwrite',
                    destructive: true,
                    onConfirm: () => save(true)
                  })
                }
              >
                Overwrite
              </Button>
            </span>
          </Tooltip>
        </Stack>
      }
    >
      <Busy show={busy !== null} label={busy ?? undefined} />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {saved && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          action={
            <Button size="small" onClick={() => void window.api.shell.showItem(saved)}>
              Show file
            </Button>
          }
        >
          Saved to {saved}
        </Alert>
      )}

      {!doc ? (
        <EmptyState
          title="No file open"
          body="Open a .xlsx, .xlsm or .csv file to view and edit it. Cells are treated as text so HSN codes keep their leading zeros and dates are not reinterpreted."
          action={
            <Button variant="contained" startIcon={<FolderOpenIcon />} onClick={() => void open()}>
              Open a spreadsheet
            </Button>
          }
        />
      ) : (
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1, gap: 1 }}>
            <Typography variant="body2" sx={{ flexGrow: 1 }} noWrap title={doc.path}>
              {doc.path.split(/[\\/]/).pop()}
            </Typography>
            <Chip size="small" label={doc.kind.toUpperCase()} />
            {doc.kind === 'csv' && (
              <Chip size="small" variant="outlined" label={`delimiter "${doc.delimiter}"`} />
            )}
            {dirty && <Chip size="small" color="warning" label="Unsaved changes" />}
          </Stack>

          {doc.truncated && (
            <Alert severity="warning" sx={{ borderRadius: 0 }}>
              This file is larger than the editor limit; only the first rows are shown. Saving would
              drop the rest, so edit it elsewhere.
            </Alert>
          )}

          {doc.sheets.length > 1 && (
            <Tabs
              value={active}
              onChange={(_e, v: number) => setActive(v)}
              variant="scrollable"
              sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40 }}
            >
              {doc.sheets.map((s) => (
                <Tab key={s.name} label={s.name} sx={{ minHeight: 40 }} />
              ))}
            </Tabs>
          )}

          <Stack direction="row" spacing={1} sx={{ px: 2, py: 1 }}>
            <Button size="small" startIcon={<AddIcon />} onClick={() => mutate((r) => [...r, Array<string>(width).fill('')])}>
              Add row
            </Button>
            <Button size="small" startIcon={<AddIcon />} onClick={() => mutate((r) => r.map((row) => [...row, '']))}>
              Add column
            </Button>
            <Divider orientation="vertical" flexItem />
            <Button
              size="small"
              startIcon={<UndoIcon />}
              disabled={!dirty}
              onClick={() =>
                confirm({
                  title: 'Discard changes?',
                  body: 'Reloads the file from disk and discards every edit made here.',
                  confirmLabel: 'Discard',
                  destructive: true,
                  onConfirm: async () => {
                    const reloaded = await window.api.sheet.read(doc.path)
                    setDoc(reloaded)
                    setDirty(false)
                  }
                })
              }
            >
              Revert
            </Button>
          </Stack>

          <TableContainer sx={{ maxHeight: 520 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 52 }} />
                  {Array.from({ length: width }, (_, c) => (
                    <TableCell key={c} align="center" sx={{ minWidth: 120 }}>
                      <Stack direction="row" alignItems="center" justifyContent="center">
                        {columnLabel(c)}
                        <Tooltip title="Delete column">
                          <IconButton
                            size="small"
                            onClick={() =>
                              confirm({
                                title: `Delete column ${columnLabel(c)}?`,
                                body: 'Removes this column from every row in the current sheet.',
                                confirmLabel: 'Delete',
                                destructive: true,
                                onConfirm: () =>
                                  mutate((rows) => rows.map((row) => row.filter((_v, i) => i !== c)))
                              })
                            }
                          >
                            <DeleteOutlineIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {sheet?.rows.map((row, r) => (
                  <TableRow key={r} hover>
                    <TableCell sx={{ color: 'text.secondary' }}>
                      <Stack direction="row" alignItems="center">
                        {r + 1}
                        <Tooltip title="Delete row">
                          <IconButton
                            size="small"
                            onClick={() =>
                              confirm({
                                title: `Delete row ${r + 1}?`,
                                body: 'Removes this row from the current sheet.',
                                confirmLabel: 'Delete',
                                destructive: true,
                                onConfirm: () => mutate((rows) => rows.filter((_v, i) => i !== r))
                              })
                            }
                          >
                            <DeleteOutlineIcon fontSize="inherit" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                    {Array.from({ length: width }, (_, c) => (
                      <TableCell key={c} sx={{ p: 0.25 }}>
                        <TextField
                          variant="standard"
                          fullWidth
                          value={row[c] ?? ''}
                          onChange={(e) =>
                            mutate((rows) => {
                              while (rows[r]!.length < width) rows[r]!.push('')
                              rows[r]![c] = e.target.value
                              return rows
                            })
                          }
                          InputProps={{ disableUnderline: true, sx: { fontSize: 13, px: 1 } }}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {sheet?.rows.length ?? 0} rows × {width} columns · saved as UTF-8 with BOM and CRLF so
              Excel reads it correctly
            </Typography>
          </Box>
        </Paper>
      )}
    </Section>
  )
}
