import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Application menu.
 *
 * Menu items never perform work directly: they send an intent to the renderer,
 * which owns screen state and dirty-buffer checks. A File > Export that bypassed
 * the renderer could export while the review grid held unsaved edits.
 */

function send(channel: string, payload?: unknown): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel, payload)
}

export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Import invoices…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:action', 'import')
        },
        {
          label: 'Open spreadsheet…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send('menu:action', 'open-sheet')
        },
        { type: 'separator' },
        {
          label: 'Export register…',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('menu:action', 'export')
        },
        {
          label: 'Save spreadsheet',
          accelerator: 'CmdOrCtrl+S',
          click: () => send('menu:action', 'save-sheet')
        },
        { type: 'separator' },
        {
          label: 'Open output folder',
          click: () => send('menu:action', 'reveal-output')
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu:navigate', 'settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          click: () => send('menu:action', 'find')
        }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Invoices', accelerator: 'CmdOrCtrl+1', click: () => send('menu:navigate', 'invoices') },
        { label: 'History', accelerator: 'CmdOrCtrl+2', click: () => send('menu:navigate', 'history') },
        { label: 'Spreadsheets', accelerator: 'CmdOrCtrl+3', click: () => send('menu:navigate', 'sheets') },
        { label: 'Local network', accelerator: 'CmdOrCtrl+4', click: () => send('menu:navigate', 'network') },
        { label: 'Profile', accelerator: 'CmdOrCtrl+5', click: () => send('menu:navigate', 'profile') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+6', click: () => send('menu:navigate', 'settings') },
        { label: 'About', accelerator: 'CmdOrCtrl+7', click: () => send('menu:navigate', 'about') },
        { type: 'separator' },
        {
          label: 'Toggle light / dark',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => send('menu:action', 'toggle-theme')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Devtools stay available in development only; shipping them invites
        // an operator into the internals of a financial tool.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: '&Window',
      submenu: [
        { role: 'minimize' },
        { label: 'Maximise', click: () => {
            const window = BrowserWindow.getFocusedWindow()
            if (window) window.isMaximized() ? window.unmaximize() : window.maximize()
          }
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Documentation', click: () => send('menu:action', 'docs') },
        {
          label: 'Keyboard shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => send('menu:action', 'shortcuts')
        },
        { type: 'separator' },
        { label: 'Send feedback…', click: () => send('menu:action', 'feedback') },
        { label: 'Check for updates', click: () => send('menu:action', 'check-updates') },
        { type: 'separator' },
        { label: 'Licences', click: () => send('menu:action', 'licences') },
        { label: `About Utility ${app.getVersion()}`, click: () => send('menu:navigate', 'about') },
        { type: 'separator' },
        { label: 'Toggle light / dark', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu:action', 'toggle-theme') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
