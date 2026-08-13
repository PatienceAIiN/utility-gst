import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Durable record of every file processed.
 *
 * Financial records are NEVER hard-deleted (brief §8): `remove` sets deletedAt
 * and writes an audit row, and `restore` brings it back. Every mutation records
 * who/what/when and the old -> new value.
 *
 * Backed by a JSON file for now. Phase 2 proper moves this to encrypted SQLite
 * (DECISIONS.md D-06); the repository shape here is deliberately the same so
 * that swap does not reach the renderer.
 */

export interface HistoryRecord {
  id: string
  sourceFile: string
  sha256: string
  invoiceNo: string | null
  invoiceDate: string | null
  party: string | null
  gstin: string | null
  supplyType: string | null
  rows: number
  taxable: string | null
  taxTotal: string | null
  grandTotal: string | null
  tieOutDelta: string | null
  blocked: boolean
  warnings: string[]
  parsedAt: string
  exportPath?: string | undefined
  note?: string | undefined
  deletedAt?: string | undefined
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

type AuditAction = 'create' | 'update' | 'soft-delete' | 'restore' | 'export'

class History {
  private path = join(app.getPath('userData'), 'history.json')
  private auditPath = join(app.getPath('userData'), 'audit.jsonl')
  private cache: HistoryRecord[] | null = null

  private load(): HistoryRecord[] {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.path)) {
        this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as HistoryRecord[]
        return this.cache
      }
    } catch {
      console.error('[history] unreadable, starting empty')
    }
    this.cache = []
    return this.cache
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.cache ?? [], null, 2), 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      console.error('[history] write failed', error)
    }
  }

  /** Append-only. Holds no amounts in the message, only in the value snapshots. */
  private audit(action: AuditAction, id: string, before: unknown, after: unknown): void {
    try {
      appendFileSync(
        this.auditPath,
        JSON.stringify({ at: new Date().toISOString(), action, id, before, after }) + '\n',
        'utf8'
      )
    } catch (error) {
      console.error('[history] audit write failed', error)
    }
  }

  /** Idempotency (brief §6.7): same file content, or same seller+invoice number. */
  findDuplicate(sha256: string, gstin: string | null, invoiceNo: string | null): HistoryRecord | null {
    return (
      this.load().find(
        (r) =>
          !r.deletedAt &&
          (r.sha256 === sha256 ||
            (invoiceNo !== null && r.invoiceNo === invoiceNo && r.gstin === gstin))
      ) ?? null
    )
  }

  add(record: Omit<HistoryRecord, 'id' | 'parsedAt'>): HistoryRecord {
    const full: HistoryRecord = { ...record, id: randomUUID(), parsedAt: new Date().toISOString() }
    this.load().unshift(full)
    this.persist()
    this.audit('create', full.id, null, full)
    return full
  }

  list(options: {
    page?: number | undefined
    pageSize?: number | undefined
    query?: string | undefined
    includeDeleted?: boolean | undefined
  }): Page<HistoryRecord> {
    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(200, Math.max(5, options.pageSize ?? 25))
    const needle = (options.query ?? '').trim().toLowerCase()

    let items = this.load().filter((r) => (options.includeDeleted ? true : !r.deletedAt))
    if (needle) {
      items = items.filter((r) =>
        [r.sourceFile, r.invoiceNo, r.party, r.gstin]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle))
      )
    }
    const total = items.length
    const start = (page - 1) * pageSize
    return { items: items.slice(start, start + pageSize), total, page, pageSize }
  }

  get(id: string): HistoryRecord | null {
    return this.load().find((r) => r.id === id) ?? null
  }

  update(
    id: string,
    patch: { note?: string | undefined; invoiceNo?: string | undefined; party?: string | undefined }
  ): HistoryRecord | null {
    const records = this.load()
    const index = records.findIndex((r) => r.id === id)
    if (index < 0) return null
    const before = { ...records[index]! }
    // Assign only the keys actually supplied. Spreading the patch would widen
    // `string | null` fields to include undefined when a key is omitted.
    const after: HistoryRecord = { ...before }
    if (patch.note !== undefined) after.note = patch.note
    if (patch.invoiceNo !== undefined) after.invoiceNo = patch.invoiceNo
    if (patch.party !== undefined) after.party = patch.party
    records[index] = after
    this.persist()
    this.audit('update', id, before, after)
    return after
  }

  remove(id: string): HistoryRecord | null {
    const records = this.load()
    const index = records.findIndex((r) => r.id === id)
    if (index < 0) return null
    const before = { ...records[index]! }
    if (before.deletedAt) return before
    const after = { ...before, deletedAt: new Date().toISOString() }
    records[index] = after
    this.persist()
    this.audit('soft-delete', id, before, after)
    return after
  }

  restore(id: string): HistoryRecord | null {
    const records = this.load()
    const index = records.findIndex((r) => r.id === id)
    if (index < 0) return null
    const before = { ...records[index]! }
    const after = { ...before }
    delete after.deletedAt
    records[index] = after
    this.persist()
    this.audit('restore', id, before, after)
    return after
  }

  recordExport(ids: string[], exportPath: string): void {
    const records = this.load()
    for (const id of ids) {
      const index = records.findIndex((r) => r.id === id)
      if (index < 0) continue
      const before = { ...records[index]! }
      records[index] = { ...before, exportPath }
      this.audit('export', id, before, records[index])
    }
    this.persist()
  }
}

export const history = new History()
