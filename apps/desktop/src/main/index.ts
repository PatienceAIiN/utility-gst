import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { sidecar } from './sidecar'

/**
 * Main process. The renderer is treated as untrusted input: every IPC payload
 * is schema-validated here before it reaches a handler (brief §3).
 */

const isDev = !app.isPackaged

// --- IPC payload schemas (the trust boundary) ------------------------------
const PathList = z.object({ paths: z.array(z.string().min(1)).min(1).max(200) })
const ExportArgs = PathList.extend({ out: z.string().min(1), force: z.boolean().optional() })

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    show: false,
    backgroundColor: '#111418',
    title: 'Utility by Patience AI',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // No remote content is ever loaded into any window (brief §3).
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

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
    buildCode: process.env['BUILD_CODE'] ?? 'dev'
  }))

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
    const results = []
    for (const path of paths) {
      try {
        results.push(await sidecar.call('parse', { path }))
      } catch (error) {
        results.push({
          source_file: path,
          error: error instanceof Error ? error.message : 'Parse failed',
          is_blocked: true
        })
      }
    }
    return results
  })

  ipcMain.handle('export:pickDir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('export:run', async (_event, raw: unknown) => {
    const args = ExportArgs.parse(raw)
    // The gate is re-run here. The disabled button in the renderer is UX only.
    return sidecar.call('export', args)
  })

  ipcMain.handle('shell:showItem', (_event, raw: unknown) => {
    const path = z.string().min(1).parse(raw)
    shell.showItemInFolder(path)
  })
}

app.whenReady().then(() => {
  registerIpc()
  sidecar.start()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => sidecar.stop())
