import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Small durable settings store in the user data directory.
 *
 * Deliberately not a dependency: this holds consent state and UI preferences,
 * not secrets. Tokens and the DB key go to Windows Credential Manager, never
 * here (brief §9).
 */

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  /** DPDP consent. Absent means never asked -- show the banner. */
  consent?: {
    analytics: boolean
    cloudSync: boolean
    decidedAt: string
    /** Bumped when the notice text materially changes, to re-prompt. */
    noticeVersion: number
  } | undefined
  confirmOnExit: boolean
  /** Version whose release notes have already been shown. */
  lastSeenVersion?: string | undefined
  /** Where generated files go. Unset means the managed default (see paths.ts). */
  downloadDir?: string | undefined
  lastExportDir?: string | undefined
}

export const NOTICE_VERSION = 1

const DEFAULTS: Settings = {
  theme: 'system',
  confirmOnExit: true
}

class Store {
  private path = join(app.getPath('userData'), 'settings.json')
  private cache: Settings | null = null

  get(): Settings {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Settings>
        this.cache = { ...DEFAULTS, ...parsed }
        return this.cache
      }
    } catch {
      // A corrupt settings file must never stop the app from opening.
      console.error('[store] settings unreadable, using defaults')
    }
    this.cache = { ...DEFAULTS }
    return this.cache
  }

  /**
   * Accepts explicit `undefined` (how zod-parsed optionals arrive). For required
   * keys undefined means "leave unchanged"; for optional keys, passing the key
   * with undefined clears it. A blind spread would let undefined overwrite a
   * required field and produce settings with no theme.
   */
  patch(update: { [K in keyof Settings]?: Settings[K] | undefined }): Settings {
    const current = this.get()
    const next: Settings = {
      ...current,
      ...(update.theme !== undefined ? { theme: update.theme } : {}),
      ...(update.confirmOnExit !== undefined ? { confirmOnExit: update.confirmOnExit } : {}),
      ...('consent' in update ? { consent: update.consent } : {}),
      ...('lastSeenVersion' in update ? { lastSeenVersion: update.lastSeenVersion } : {}),
      ...('downloadDir' in update ? { downloadDir: update.downloadDir } : {}),
      ...('lastExportDir' in update ? { lastExportDir: update.lastExportDir } : {})
    }
    this.cache = next
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Write-then-rename so a crash mid-write cannot truncate the file.
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      console.error('[store] settings write failed', error)
    }
    return next
  }

  needsConsent(): boolean {
    const { consent } = this.get()
    return !consent || consent.noticeVersion < NOTICE_VERSION
  }
}

export const store = new Store()
