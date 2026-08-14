import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { auth } from './auth'
import { history } from './history'
import { buildMenu } from './menu'
import { passcode } from './passcode'
import { flushOutbox, installCrashHandlers, reportError, sendFeedback } from './telemetry'
import { mesh, type Permission } from './mesh'
import { check as checkUpdates, currentState, initUpdater, installNow } from './updater'
import { baseDir, layoutPreview, outputDir } from './paths'
import { sidecar } from './sidecar'
import {
  applyQueuedRestore,
  backendUrl,
  changePassword,
  clearBackupKey,
  consumeUnlock,
  setBackupKey,
  deriveBackupKey,
  listRemote,
  lockState,
  reportLock,
  restoreRemote,
  runBackup,
  serverSignIn,
  status as syncStatus
} from './sync'
import { NOTICE_VERSION, store } from './store'

/** Shape the sidecar returns for a parsed invoice. Validated on arrival, not trusted. */
interface ParsedInvoice {
  source_file: string
  sha256?: string
  invoice_no?: string | null
  invoice_date?: string | null
  buyer_name?: string | null
  buyer_gstin?: string | null
  supply_type?: string | null
  line_items?: unknown[]
  totals?: Record<string, string | null>
  findings?: { rule_code: string; severity: string }[]
  is_blocked?: boolean
  error?: string
}

/**
 * Main process. The renderer is treated as untrusted input: every IPC payload
 * is schema-validated here before it reaches a handler (brief §3).
 */

const isDev = !app.isPackaged

// --- IPC payload schemas (the trust boundary) ------------------------------
const PathList = z.object({ paths: z.array(z.string().min(1)).min(1).max(200) })
const ExportArgs = PathList.extend({ out: z.string().optional(), force: z.boolean().optional() })
const SheetPath = z.object({ path: z.string().min(1) })
const SheetSave = z.object({
  path: z.string().min(1),
  sheets: z.array(z.object({ name: z.string(), rows: z.array(z.array(z.string())) })).min(1),
  overwrite: z.boolean().optional(),
  delimiter: z.string().max(1).optional()
})
const Consent = z.object({ analytics: z.boolean(), cloudSync: z.boolean() })
const SettingsPatch = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  confirmOnExit: z.boolean().optional()
})
const Feedback = z.object({
  kind: z.enum(['bug', 'idea', 'other']),
  message: z.string().min(1).max(5000),
  email: z.string().email().optional().or(z.literal(''))
})

/** Set while an import or export is running, so a quit cannot lose work. */
let busyReason: string | null = null
let quitConfirmed = false

let splash: BrowserWindow | null = null

/**
 * Splash while the sidecar spawns and the renderer bundle parses. Frameless and
 * non-interactive; it closes as soon as the real window is ready to show, so it
 * can never outlive startup or trap the operator if the app fails to load.
 */
function showSplash(): void {
  splash = new BrowserWindow({
    width: 380,
    height: 300,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    backgroundColor: '#111827',
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  void splash.loadFile(join(__dirname, 'splash.html'))
  splash.once('ready-to-show', () => splash?.show())
}

function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.close()
  splash = null
}

let browser: BrowserWindow | null = null

/**
 * In-app browser for our own site.
 *
 * The brief forbids remote content in any application window (§3), so this is a
 * SEPARATE window that shares nothing with the app: no preload, no IPC bridge,
 * sandboxed, context-isolated. It cannot reach invoices, the database or the
 * sidecar even if the page were compromised.
 *
 * Navigation is pinned to patienceai.in. A link to anywhere else is handed to
 * the system browser rather than followed here, so a redirect cannot turn this
 * into a general-purpose browser inside a financial application.
 */
const ALLOWED_HOST = /^https:\/\/(www\.)?patienceai\.in(\/|$)/

export function openInApp(url: string, title = 'Patience AI'): void {
  if (!ALLOWED_HOST.test(url)) return
  if (browser && !browser.isDestroyed()) {
    browser.focus()
    void browser.loadURL(url)
    return
  }
  browser = new BrowserWindow({
    width: 1100,
    height: 800,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      // No preload: this window has no bridge to the application at all.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })
  browser.on('closed', () => {
    browser = null
  })
  browser.webContents.on('will-navigate', (event, target) => {
    if (!ALLOWED_HOST.test(target)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })
  browser.webContents.setWindowOpenHandler(({ url: target }) => {
    if (ALLOWED_HOST.test(target)) {
      void browser?.loadURL(target)
    } else {
      void shell.openExternal(target)
    }
    return { action: 'deny' }
  })
  void browser.loadURL(url)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'Utility by Patience AI',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    closeSplash()
    window.show()
  })

  // No remote content is ever loaded into any window (brief §3).
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInApp(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('did-fail-load', () => closeSplash())
  window.webContents.on('render-process-gone', (_e, details) =>
    reportError('renderer-gone', details.reason)
  )

  window.on('close', (event) => {
    if (quitConfirmed) return
    const { confirmOnExit } = store.get()
    if (!confirmOnExit && !busyReason) return

    event.preventDefault()
    const inFlight = busyReason !== null
    const choice = dialog.showMessageBoxSync(window, {
      type: inFlight ? 'warning' : 'question',
      buttons: inFlight ? ['Keep working', 'Quit anyway'] : ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Quit Utility?',
      message: inFlight ? `${busyReason} is still running.` : 'Quit Utility?',
      detail: inFlight
        ? 'Quitting now will lose the work in progress.'
        : 'Any unsaved edits in the review grid will be lost.'
    })
    if (choice === 1) {
      quitConfirmed = true
      window.close()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    channel: process.env['UPDATE_CHANNEL'] ?? 'modern',
    // CI sets BUILD_CODE. Unset means a local build, which for a packaged app
    // should read as "production" rather than the internal "dev" placeholder.
    buildCode: process.env['BUILD_CODE'] ?? (app.isPackaged ? 'production' : 'dev'),
    platform: process.platform,
    electron: process.versions.electron,
    noticeVersion: NOTICE_VERSION
  }))

  // --- settings & consent ---
  ipcMain.handle('settings:get', () => ({
    ...store.get(),
    needsConsent: store.needsConsent()
  }))
  ipcMain.handle('settings:patch', (_event, raw: unknown) =>
    store.patch(SettingsPatch.parse(raw))
  )
  ipcMain.handle('consent:set', (_event, raw: unknown) => {
    const value = Consent.parse(raw)
    return store.patch({
      consent: { ...value, decidedAt: new Date().toISOString(), noticeVersion: NOTICE_VERSION }
    })
  })

  // --- files & parsing ---
  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select invoices',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Invoices', extensions: ['pdf'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('invoice:parse', async (_event, raw: unknown) => {
    const { paths } = PathList.parse(raw)
    busyReason = 'An import'
    try {
      const results: ParsedInvoice[] = []
      for (const path of paths) {
        try {
          const parsed = await sidecar.call<ParsedInvoice>('parse', { path })
          const duplicate = history.findDuplicate(
            parsed.sha256 ?? '',
            parsed.buyer_gstin ?? null,
            parsed.invoice_no ?? null
          )
          const record = history.add({
            sourceFile: parsed.source_file,
            sha256: parsed.sha256 ?? '',
            invoiceNo: parsed.invoice_no ?? null,
            invoiceDate: parsed.invoice_date ?? null,
            party: parsed.buyer_name ?? null,
            gstin: parsed.buyer_gstin ?? null,
            supplyType: parsed.supply_type ?? null,
            rows: parsed.line_items?.length ?? 0,
            taxable: parsed.totals?.['taxable'] ?? null,
            taxTotal: parsed.totals?.['tax_total'] ?? null,
            grandTotal: parsed.totals?.['computed_grand_total'] ?? null,
            tieOutDelta: parsed.totals?.['tie_out_delta'] ?? null,
            blocked: Boolean(parsed.is_blocked),
            warnings: (parsed.findings ?? []).map((f) => f.rule_code)
          })
          results.push({ ...parsed, historyId: record.id, duplicateOf: duplicate?.id ?? null } as ParsedInvoice)
        } catch (error) {
          results.push({
            source_file: path,
            error: error instanceof Error ? error.message : 'Parse failed',
            is_blocked: true
          })
        }
      }
      return results
    } finally {
      busyReason = null
    }
  })

  ipcMain.handle('export:pickDir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null
    const dir = result.filePaths[0]
    if (dir) store.patch({ lastExportDir: dir })
    return dir ?? null
  })

  ipcMain.handle('export:run', async (_event, raw: unknown) => {
    const args = ExportArgs.parse(raw)
    busyReason = 'An export'
    try {
      // The gate is re-run here. The disabled button in the renderer is UX only.
      // Always the managed location. Honouring a picked folder here is what made
      // exports ignore the folder configured in Settings.
      return await sidecar.call('export', { ...args, out: outputDir('registers') })
    } finally {
      busyReason = null
    }
  })

  // --- history (paginated CRUD; financial records are soft-deleted only) ---
  const HistoryQuery = z.object({
    page: z.number().int().min(1).max(10_000).optional(),
    pageSize: z.number().int().min(5).max(200).optional(),
    query: z.string().max(200).optional(),
    includeDeleted: z.boolean().optional()
  })
  const HistoryId = z.object({ id: z.string().uuid() })
  const HistoryPatch = HistoryId.extend({
    note: z.string().max(2000).optional(),
    invoiceNo: z.string().max(120).optional(),
    party: z.string().max(300).optional()
  })

  ipcMain.handle('history:list', (_event, raw: unknown) => history.list(HistoryQuery.parse(raw ?? {})))
  ipcMain.handle('history:get', (_event, raw: unknown) => history.get(HistoryId.parse(raw).id))
  ipcMain.handle('history:update', (_event, raw: unknown) => {
    const { id, ...patch } = HistoryPatch.parse(raw)
    return history.update(id, patch)
  })
  ipcMain.handle('history:remove', (_event, raw: unknown) => history.remove(HistoryId.parse(raw).id))
  ipcMain.handle('history:restore', (_event, raw: unknown) => history.restore(HistoryId.parse(raw).id))

  /** Re-export a single historical record to a folder the user chooses. */
  ipcMain.handle('history:download', async (_event, raw: unknown) => {
    const record = history.get(HistoryId.parse(raw).id)
    if (!record) throw new Error('That record no longer exists.')
    const exported = await sidecar.call<{ path: string }>('export', {
      paths: [record.sourceFile],
      out: outputDir('registers')
    })
    history.recordExport([record.id], exported.path)
    return exported
  })

  // --- screen lock ---
  const Code = z.object({ code: z.string().regex(/^\d{4}$/) })
  ipcMain.handle('passcode:status', () => passcode.status())
  ipcMain.handle('passcode:set', (_event, raw: unknown) => {
    const result = passcode.set(Code.parse(raw).code)
    // Tell the server a lock exists so support can release it later. The
    // passcode is not sent -- only the fact that one is set.
    if (result.ok) void reportLock(true)
    return result
  })
  ipcMain.handle('passcode:verify', (_event, raw: unknown) => passcode.verify(Code.parse(raw).code))
  ipcMain.handle('passcode:disable', (_event, raw: unknown) => {
    const result = passcode.disable(Code.parse(raw).code)
    if (result.ok) void reportLock(false)
    return result
  })
  ipcMain.handle('passcode:lock', () => {
    passcode.lock()
    return passcode.status()
  })

  /**
   * Has an administrator released this machine's lock?
   *
   * Polled from the lock screen, which is the only place it can help: someone
   * who has forgotten their passcode cannot get far enough into the app to ask
   * for anything else. The grant is issued against the signed-in account and is
   * spent server-side once the lock is actually gone.
   */
  ipcMain.handle('passcode:checkRelease', async () => {
    if (!passcode.status().enabled) return { released: false }
    const state = await lockState()
    if (!state.unlockGranted) return { released: false }
    passcode.releaseByGrant()
    await consumeUnlock()
    return { released: true }
  })

  /**
   * Which version the operator has already been shown release notes for.
   * Kept in main rather than localStorage so it survives a cache clear and
   * cannot be reset by the renderer.
   */
  ipcMain.handle('whatsnew:seen', () => store.get().lastSeenVersion ?? null)
  ipcMain.handle('whatsnew:ack', () => {
    store.patch({ lastSeenVersion: app.getVersion() })
    return true
  })

  // --- accounts (entirely local unless cloud backup is switched on) ---
  const Credentials = z.object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024)
  })
  const SignUp = Credentials.extend({
    name: z.string().min(1).max(200),
    org: z.string().max(200).optional(),
    gstin: z.string().max(20).optional()
  })
  const Reset = Credentials.extend({ recoveryCode: z.string().min(4).max(64) })
  const Profile = z.object({
    name: z.string().max(200).optional(),
    org: z.string().max(200).optional(),
    gstin: z.string().max(20).optional()
  })
  const ChangePassword = z.object({
    current: z.string().min(1).max(1024),
    next: z.string().min(1).max(1024)
  })

  ipcMain.handle('auth:status', () => auth.status())
  ipcMain.handle('auth:signUp', async (_event, raw: unknown) => {
    const input = SignUp.parse(raw)
    const result = auth.signUp(input)
    if (result.ok) {
      auth.rememberSession(deriveBackupKey(input.password))
      if (store.get().consent?.cloudSync === true) {
        void serverSignIn(input.email, input.password, input.name)
      }
    }
    return result
  })
  ipcMain.handle('auth:signIn', async (_event, raw: unknown) => {
    const { email, password } = Credentials.parse(raw)
    const result = auth.signIn(email, password)
    if (result.ok) {
      auth.rememberSession(deriveBackupKey(password))
      // If cloud backup is on, establish the server session here so the
      // operator never sees or configures anything about a backend.
      if (store.get().consent?.cloudSync === true) {
        void serverSignIn(email, password, result.account.name)
      }
    }
    return result
  })
  ipcMain.handle('auth:signOut', () => {
    auth.signOut()
    clearBackupKey()
    // Cloud backup cannot function without the sign-in-derived key, so signing
    // out switches it off rather than leaving a toggle on that does nothing.
    const current = store.get().consent
    if (current?.cloudSync) {
      store.patch({ consent: { ...current, cloudSync: false } })
    }
    return auth.status()
  })
  ipcMain.handle('auth:reset', (_event, raw: unknown) => {
    const { email, recoveryCode, password } = Reset.parse(raw)
    const result = auth.resetPassword(email, recoveryCode, password)
    if (result.ok) deriveBackupKey(password)
    return result
  })
  ipcMain.handle('auth:otpRequest', async (_event, raw: unknown) => {
    const email = z.string().email().max(320).parse(raw)
    try {
      const response = await fetch(`${backendUrl()}/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(20000)
      })
      return response.ok
        ? { ok: true }
        : { ok: false, error: 'Could not send the code. Try again shortly.' }
    } catch {
      return { ok: false, error: 'No connection. A code can only be sent when online.' }
    }
  })

  ipcMain.handle('auth:otpReset', async (_event, raw: unknown) => {
    const { email, code, password } = z
      .object({
        email: z.string().email().max(320),
        code: z.string().min(4).max(8),
        password: z.string().min(1).max(1024)
      })
      .parse(raw)
    try {
      const response = await fetch(`${backendUrl()}/v1/auth/otp/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
        signal: AbortSignal.timeout(20000)
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string }
        return { ok: false, error: detail.error ?? 'That code is not right.' }
      }
    } catch {
      return { ok: false, error: 'No connection. Verifying a code needs the internet.' }
    }
    const result = auth.resetVerified(email, password)
    if (result.ok) auth.rememberSession(deriveBackupKey(password))
    return result
  })

  ipcMain.handle('auth:deleteAccount', () => {
    auth.deleteAccount()
    clearBackupKey()
    const current = store.get().consent
    if (current?.cloudSync) store.patch({ consent: { ...current, cloudSync: false } })
    return auth.status()
  })

  ipcMain.handle('auth:updateProfile', (_event, raw: unknown) => auth.updateProfile(Profile.parse(raw)))
  ipcMain.handle('auth:changePassword', (_event, raw: unknown) => {
    const { current, next } = ChangePassword.parse(raw)
    const result = auth.changePassword(current, next)
    if (result.ok) auth.rememberSession(deriveBackupKey(next))
    return result
  })

  // --- cloud backup ---
  ipcMain.handle('sync:status', () => syncStatus())
  /** Probe the configured server so misconfiguration is visible before a backup. */
  ipcMain.handle('sync:probe', async () => {
    try {
      const response = await fetch(`${backendUrl()}/healthz`, {
        signal: AbortSignal.timeout(6000)
      })
      return response.ok
        ? { ok: true, reason: `Reachable (${response.status}).` }
        : { ok: false, reason: `Server answered ${response.status}.` }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'Unreachable.' }
    }
  })
  ipcMain.handle('sync:run', async () => runBackup())
  ipcMain.handle('sync:serverSignIn', async (_event, raw: unknown) => {
    const { email, password } = Credentials.parse(raw)
    const account = auth.status().account
    return serverSignIn(email, password, account?.name ?? email)
  })
  ipcMain.handle('sync:listRemote', async () => listRemote())
  ipcMain.handle('sync:restore', async (_event, raw: unknown) =>
    restoreRemote(z.object({ name: z.string().min(1).max(200) }).parse(raw).name)
  )
  /**
   * Pick up a restore an administrator queued for this account.
   *
   * The server holds only the sealed bundle; the decryption happens here with
   * the user's own key, and the queue entry is cleared only once that succeeds.
   */
  ipcMain.handle('sync:applyQueuedRestore', async () => {
    const name = await applyQueuedRestore()
    return { applied: name !== null, name }
  })
  /** Account state the server owns: suspension and a pending password change. */
  ipcMain.handle('sync:accountState', async () => {
    const state = await lockState()
    return { suspended: state.suspended, mustChangePassword: state.mustChangePassword }
  })
  ipcMain.handle('sync:changePassword', async (_event, raw: unknown) => {
    const { current, replacement } = z
      .object({ current: z.string().min(1), replacement: z.string().min(10).max(1024) })
      .parse(raw)
    return changePassword(current, replacement)
  })

  // --- intranet mesh (off by default) ---
  const DeviceId = z.object({ deviceId: z.string().min(1).max(64) })
  const Grants = DeviceId.extend({
    grants: z.array(z.enum(['view', 'read', 'write'])).max(3)
  })

  ipcMain.handle('mesh:status', () => mesh.status())
  ipcMain.handle('mesh:enable', async (_event, raw: unknown) => {
    const on = z.boolean().parse(raw)
    if (on) await mesh.start()
    else mesh.stop()
    return mesh.status()
  })
  ipcMain.handle('mesh:setName', (_event, raw: unknown) => {
    mesh.setDeviceName(z.string().min(1).max(80).parse(raw))
    return mesh.status()
  })
  ipcMain.handle('mesh:requestPair', (_event, raw: unknown) =>
    mesh.requestPair(DeviceId.parse(raw).deviceId)
  )
  ipcMain.handle('mesh:approvePair', (_event, raw: unknown) => {
    const { deviceId, code } = DeviceId.extend({ code: z.string().min(4).max(8) }).parse(raw)
    return mesh.approvePair(deviceId, code)
  })
  ipcMain.handle('mesh:rejectPair', (_event, raw: unknown) => {
    mesh.rejectPair(DeviceId.parse(raw).deviceId)
    return mesh.status()
  })
  ipcMain.handle('mesh:setGrants', (_event, raw: unknown) => {
    const { deviceId, grants } = Grants.parse(raw)
    return mesh.setGrants(deviceId, grants as Permission[])
  })
  ipcMain.handle('mesh:unpair', (_event, raw: unknown) => {
    mesh.unpair(DeviceId.parse(raw).deviceId)
    return mesh.status()
  })
  ipcMain.handle('mesh:fetchRecord', (_event, raw: unknown) => {
    const { deviceId, id } = DeviceId.extend({ id: z.string().min(1).max(64) }).parse(raw)
    return mesh.fetchRecord(deviceId, id)
  })
  ipcMain.handle('mesh:browse', (_event, raw: unknown) => mesh.browse(DeviceId.parse(raw).deviceId))
  ipcMain.handle('mesh:share', (_event, raw: unknown) => {
    const { deviceId, id } = DeviceId.extend({ id: z.string().uuid() }).parse(raw)
    const record = history.get(id)
    if (!record) throw new Error('That record no longer exists.')
    return mesh.pushRecord(deviceId, record)
  })

  // --- download location ---
  ipcMain.handle('paths:info', () => layoutPreview())
  ipcMain.handle('paths:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where Utility saves files',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return layoutPreview()
    store.patch({ downloadDir: result.filePaths[0] })
    return layoutPreview()
  })
  ipcMain.handle('paths:reset', () => {
    store.patch({ downloadDir: undefined })
    return layoutPreview()
  })
  ipcMain.handle('paths:reveal', () => {
    const dir = baseDir()
    mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
  })

  // --- spreadsheets ---
  ipcMain.handle('sheet:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open spreadsheet',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'csv'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('sheet:read', (_event, raw: unknown) =>
    sidecar.call('sheet.read', SheetPath.parse(raw))
  )
  ipcMain.handle('sheet:write', (_event, raw: unknown) => {
    const args = SheetSave.parse(raw)
    if (args.overwrite) return sidecar.call('sheet.write', args)
    // Non-destructive saves go to the managed Spreadsheets folder.
    const name = args.path.split(/[\\/]/).pop() ?? 'sheet.xlsx'
    return sidecar.call('sheet.write', {
      ...args,
      path: join(outputDir('spreadsheets'), name)
    })
  })

  // --- feedback ---
  ipcMain.handle('feedback:send', async (_event, raw: unknown) => {
    const value = Feedback.parse(raw)
    return sendFeedback(value.kind, value.message, value.email ?? '')
  })

  // --- updates ---
  ipcMain.handle('updates:state', () =>
    auth.status().signedIn ? currentState() : { status: 'signin-required' as const }
  )
  ipcMain.handle('updates:check', async () => {
    // Updates are tied to an account so a licence check can be enforced later.
    if (!auth.status().signedIn) return { status: 'signin-required' as const }
    return checkUpdates()
  })
  ipcMain.handle('updates:install', () => {
    installNow()
  })

  ipcMain.handle('shell:showItem', (_event, raw: unknown) => {
    shell.showItemInFolder(z.string().min(1).parse(raw))
  })
  ipcMain.handle('shell:openExternal', (_event, raw: unknown) => {
    // Opens inside the app in an isolated window. Still allowlisted: the
    // renderer must not be able to point this at an arbitrary host.
    openInApp(z.string().url().parse(raw))
  })
}

app.whenReady().then(() => {
  registerIpc()
  installCrashHandlers()
  // Stay signed in across restarts and updates.
  const remembered = auth.restoreSession()
  if (remembered) setBackupKey(remembered)
  buildMenu()
  showSplash()
  sidecar.start()
  createWindow()
  initUpdater()
  // Deliver anything that could not be sent while offline.
  setTimeout(() => void flushOutbox(), 8000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => sidecar.stop())
