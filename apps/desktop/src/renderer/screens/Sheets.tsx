import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Alert, Box, Button, Chip, Divider, IconButton, Menu, MenuItem, Paper, Stack, Tab, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import SaveIcon from '@mui/icons-material/Save'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import UndoIcon from '@mui/icons-material/Undo'
import RedoIcon from '@mui/icons-material/Redo'
import FunctionsIcon from '@mui/icons-material/Functions'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import type { SheetDoc } from '../../preload/index'
import { Busy, EmptyState, Section, type ConfirmSpec } from '../ui'
import { SUPPORTED_FUNCTIONS, displayValue, indexToColumn, isFormula } from '../formula'

/**
 * Spreadsheet editor.
 *
 * Cells hold text. Formulas (leading "=") are previewed live by a restricted
 * parser and written to .xlsx as real formulas so Excel recalculates them
 * natively. Non-formula values are never re-typed on save: that is what keeps
 * HSN leading zeros and dd-mm-yyyy dates intact.
 */

interface Snapshot {
  sheets: { name: string; rows: string[][] }[]
  active: number
}

const HISTORY_LIMIT = 50

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
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement; kind: 'row' | 'col'; index: number } | null>(null)

  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])

  const sheet = doc?.sheets[active]
  const grid = sheet?.rows ?? []
  const width = useMemo(() => Math.max(1, ...grid.map((r) => r.length)), [grid])

  const snapshot = useCallback((): Snapshot | null => {
    if (!doc) return null
    return { sheets: doc.sheets.map((s) => ({ name: s.name, rows: s.rows.map((r) => [...r]) })), active }
  }, [doc, active])

  const apply = useCallback(
    (fn: (rows: string[][]) => string[][]) => {
      const before = snapshot()
      if (before) {
        undoStack.current.push(before)
        if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
        redoStack.current = []
      }
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
    [active, snapshot]
  )

  const restore = useCallback(
    (from: 'undo' | 'redo') => {
      const source = from === 'undo' ? undoStack.current : redoStack.current
      const target = from === 'undo' ? redoStack.current : undoStack.current
      const state = source.pop()
      if (!state || !doc) return
      const current = snapshot()
      if (current) target.push(current)
      setDoc({ ...doc, sheets: state.sheets })
      setActive(state.active)
      setDirty(true)
    },
    [doc, snapshot]
  )

  /** Pad every row so an inserted column is not ragged. */
  const normalise = (rows: string[][], w: number): string[][] =>
    rows.map((row) => {
      const copy = [...row]
      while (copy.length < w) copy.push('')
      return copy
    })

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
      undoStack.current = []
      redoStack.current = []
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

  const selectedRaw = selected ? (grid[selected.r]?.[selected.c] ?? '') : ''

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

          {/* Formula bar */}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1 }}>
            <Chip
              size="small"
              variant="outlined"
              label={selected ? `${indexToColumn(selected.c)}${selected.r + 1}` : '—'}
              sx={{ minWidth: 68, fontFamily: 'monospace' }}
            />
            <FunctionsIcon fontSize="small" color="disabled" />
            <TextField
              size="small"
              fullWidth
              placeholder={selected ? 'Value, or =SUM(A1:A10)' : 'Select a cell'}
              disabled={!selected}
              value={selectedRaw}
              onChange={(e) => {
                const value = e.target.value
                if (!selected) return
                apply((rows) => {
                  const padded = normalise(rows, width)
                  padded[selected.r]![selected.c] = value
                  return padded
                })
              }}
              InputProps={{ sx: { fontFamily: isFormula(selectedRaw) ? 'monospace' : 'inherit' } }}
            />
          </Stack>
          <Divider />

          {/* Toolbar */}
          <Stack direction="row" spacing={1} sx={{ px: 2, py: 1 }} flexWrap="wrap" useFlexGap>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => apply((rows) => [...normalise(rows, width), Array<string>(width).fill('')])}
            >
              Row
            </Button>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => apply((rows) => normalise(rows, width).map((row) => [...row, '']))}
            >
              Column
            </Button>
            <Divider orientation="vertical" flexItem />
            <Tooltip title="Undo">
              <span>
                <Button size="small" startIcon={<UndoIcon />} disabled={!undoStack.current.length} onClick={() => restore('undo')}>
                  Undo
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Redo">
              <span>
                <Button size="small" startIcon={<RedoIcon />} disabled={!redoStack.current.length} onClick={() => restore('redo')}>
                  Redo
                </Button>
              </span>
            </Tooltip>
            <Divider orientation="vertical" flexItem />
            <Button
              size="small"
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
                    undoStack.current = []
                    redoStack.current = []
                  }
                })
              }
            >
              Revert
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              Functions: {SUPPORTED_FUNCTIONS.join(', ')}
            </Typography>
          </Stack>

          <TableContainer sx={{ maxHeight: 520 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 60 }} />
                  {Array.from({ length: width }, (_, c) => (
                    <TableCell key={c} align="center" sx={{ minWidth: 130 }}>
                      <Stack direction="row" alignItems="center" justifyContent="center">
                        {indexToColumn(c)}
                        <IconButton size="small" onClick={(e) => setMenu({ el: e.currentTarget, kind: 'col', index: c })}>
                          <MoreVertIcon fontSize="inherit" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {grid.map((row, r) => (
                  <TableRow key={r} hover>
                    <TableCell sx={{ color: 'text.secondary' }}>
                      <Stack direction="row" alignItems="center">
                        {r + 1}
                        <IconButton size="small" onClick={(e) => setMenu({ el: e.currentTarget, kind: 'row', index: r })}>
                          <MoreVertIcon fontSize="inherit" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                    {Array.from({ length: width }, (_, c) => {
                      const raw = row[c] ?? ''
                      const isSelected = selected?.r === r && selected?.c === c
                      const formula = isFormula(raw)
                      return (
                        <TableCell
                          key={c}
                          onClick={() => setSelected({ r, c })}
                          sx={{
                            p: 0.25,
                            outline: isSelected ? '2px solid' : 'none',
                            outlineColor: 'primary.main',
                            bgcolor: formula ? 'action.hover' : 'transparent'
                          }}
                        >
                          <TextField
                            variant="standard"
                            fullWidth
                            value={isSelected ? raw : displayValue(raw, grid)}
                            onFocus={() => setSelected({ r, c })}
                            onChange={(e) =>
                              apply((rows) => {
                                const padded = normalise(rows, width)
                                padded[r]![c] = e.target.value
                                return padded
                              })
                            }
                            InputProps={{
                              disableUnderline: true,
                              sx: {
                                fontSize: 13,
                                px: 1,
                                fontFamily: formula && isSelected ? 'monospace' : 'inherit',
                                color: displayValue(raw, grid) === '#ERROR' ? 'error.main' : 'inherit'
                              }
                            }}
                          />
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {grid.length} rows × {width} columns · formulas are written to Excel as real formulas;
              CSV and Excel are saved UTF-8 with BOM and CRLF
            </Typography>
          </Box>
        </Paper>
      )}

      {/* Row/column operations */}
      <Menu anchorEl={menu?.el ?? null} open={menu !== null} onClose={() => setMenu(null)}>
        {menu?.kind === 'row'
          ? [
              <MenuItem
                key="above"
                onClick={() => {
                  apply((rows) => {
                    const padded = normalise(rows, width)
                    padded.splice(menu.index, 0, Array<string>(width).fill(''))
                    return padded
                  })
                  setMenu(null)
                }}
              >
                Insert row above
              </MenuItem>,
              <MenuItem
                key="below"
                onClick={() => {
                  apply((rows) => {
                    const padded = normalise(rows, width)
                    padded.splice(menu.index + 1, 0, Array<string>(width).fill(''))
                    return padded
                  })
                  setMenu(null)
                }}
              >
                Insert row below
              </MenuItem>,
              <MenuItem
                key="dup"
                onClick={() => {
                  apply((rows) => {
                    const padded = normalise(rows, width)
                    padded.splice(menu.index + 1, 0, [...(padded[menu.index] ?? [])])
                    return padded
                  })
                  setMenu(null)
                }}
              >
                Duplicate row
              </MenuItem>,
              <MenuItem
                key="clear"
                onClick={() => {
                  apply((rows) => {
                    const padded = normalise(rows, width)
                    padded[menu.index] = Array<string>(width).fill('')
                    return padded
                  })
                  setMenu(null)
                }}
              >
                Clear contents
              </MenuItem>,
              <MenuItem
                key="del"
                onClick={() => {
                  const index = menu.index
                  setMenu(null)
                  confirm({
                    title: `Delete row ${index + 1}?`,
                    body: 'Removes the row from this sheet. You can undo it.',
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: () => apply((rows) => rows.filter((_v, i) => i !== index))
                  })
                }}
              >
                Delete row
              </MenuItem>
            ]
          : [
              <MenuItem
                key="left"
                onClick={() => {
                  apply((rows) =>
                    normalise(rows, width).map((row) => {
                      const copy = [...row]
                      copy.splice(menu!.index, 0, '')
                      return copy
                    })
                  )
                  setMenu(null)
                }}
              >
                Insert column left
              </MenuItem>,
              <MenuItem
                key="right"
                onClick={() => {
                  apply((rows) =>
                    normalise(rows, width).map((row) => {
                      const copy = [...row]
                      copy.splice(menu!.index + 1, 0, '')
                      return copy
                    })
                  )
                  setMenu(null)
                }}
              >
                Insert column right
              </MenuItem>,
              <MenuItem
                key="clearc"
                onClick={() => {
                  apply((rows) =>
                    normalise(rows, width).map((row) => {
                      const copy = [...row]
                      copy[menu!.index] = ''
                      return copy
                    })
                  )
                  setMenu(null)
                }}
              >
                Clear contents
              </MenuItem>,
              <MenuItem
                key="delc"
                onClick={() => {
                  const index = menu!.index
                  setMenu(null)
                  confirm({
                    title: `Delete column ${indexToColumn(index)}?`,
                    body: 'Removes this column from every row in the sheet. You can undo it.',
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: () =>
                      apply((rows) => rows.map((row) => row.filter((_v, i) => i !== index)))
                  })
                }}
              >
                Delete column
              </MenuItem>
            ]}
      </Menu>
    </Section>
  )
}
