import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { store } from './store'

/**
 * Where generated files go.
 *
 * By default everything lands in one folder the operator can find, created on
 * first use, with a predictable structure -- rather than scattering exports
 * wherever the last folder picker happened to point. Registers are bucketed by
 * month because a working register folder accumulates fast.
 */

export const DEFAULT_FOLDER_NAME = 'Utility by Patience AI'

export type OutputKind = 'registers' | 'spreadsheets'

export function baseDir(): string {
  return store.get().downloadDir ?? join(app.getPath('downloads'), DEFAULT_FOLDER_NAME)
}

export function outputDir(kind: OutputKind): string {
  const base = baseDir()
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir =
    kind === 'registers' ? join(base, 'Registers', month) : join(base, 'Spreadsheets')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Describes the layout for the Settings screen without needing it to exist yet. */
export function layoutPreview(): { base: string; entries: string[] } {
  return {
    base: baseDir(),
    entries: ['Registers/YYYY-MM/  — exported sales registers', 'Spreadsheets/  — edited CSV and Excel files']
  }
}
