import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

/**
 * Silent, channel-aware OTA.
 *
 * Downloads in the background and installs when the operator quits -- never
 * mid-session (brief §10). Someone halfway through a forty-invoice import must
 * not lose the work to an update, so the install is deferred rather than
 * prompted for.
 */

const { autoUpdater } = electronUpdater

export type UpdateState =
  | { status: 'dev' }
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string; notes?: string | undefined }
  | { status: 'error'; detail: string }
  | { status: 'signin-required' }

let state: UpdateState = { status: 'current', version: app.getVersion() }
let wired = false

function broadcast(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('updates:state', state)
  }
}

function set(next: UpdateState): void {
  state = next
  broadcast()
}

export function currentState(): UpdateState {
  return app.isPackaged ? state : { status: 'dev' }
}

export function initUpdater(): void {
  if (wired || !app.isPackaged) return
  wired = true

  autoUpdater.autoDownload = true
  // The whole point: apply on quit, never interrupt.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.channel = process.env['UPDATE_CHANNEL'] === 'legacy' ? 'legacy' : 'latest'
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
  autoUpdater.on('update-not-available', () =>
    set({ status: 'current', version: app.getVersion() })
  )
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }))
  autoUpdater.on('download-progress', (progress) =>
    set({
      status: 'downloading',
      version: state.status === 'available' ? state.version : app.getVersion(),
      percent: Math.round(progress.percent)
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    set({
      status: 'ready',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : undefined
    })
  )
  autoUpdater.on('error', (error) =>
    // A failed update check must never surface as a crash or a modal.
    set({ status: 'error', detail: error instanceof Error ? error.message : String(error) })
  )

  // Check shortly after launch so startup is not delayed, then every six hours.
  setTimeout(() => void check(), 15_000)
  setInterval(() => void check(), 6 * 60 * 60 * 1000)
}

export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return { status: 'dev' }
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    set({ status: 'error', detail: error instanceof Error ? error.message : 'Check failed' })
  }
  return state
}

/** Only used when the operator explicitly asks to restart now. */
export function installNow(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall(false, true)
}
