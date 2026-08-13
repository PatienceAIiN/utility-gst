import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { check as checkUpdates } from './updater'

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

const go = (route: string, accelerator?: string): MenuItemConstructorOptions => ({
  label: route.charAt(0).toUpperCase() + route.slice(1).replace('-', ' '),
  ...(accelerator ? { accelerator } : {}),
  click: () => send('menu:navigate', route)
})

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
        go('invoices', 'CmdOrCtrl+1'),
        go('history', 'CmdOrCtrl+2'),
        go('sheets', 'CmdOrCtrl+3'),
        { label: 'Local network', accelerator: 'CmdOrCtrl+4', click: () => send('menu:navigate', 'network') },
        go('profile', 'CmdOrCtrl+5'),
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
        {
          label: 'Documentation',
          click: () => void shell.openExternal('https://patienceai.in/utility/#docs')
        },
        {
          label: 'Keyboard shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => send('menu:action', 'shortcuts')
        },
        { type: 'separator' },
        { label: 'Send feedback…', click: () => send('menu:action', 'feedback') },
        {
          label: 'Check for updates',
          click: () => {
            void checkUpdates()
            send('menu:navigate', 'settings')
          }
        },
        { type: 'separator' },
        { label: 'Licences', click: () => send('menu:action', 'licences') },
        { label: `About Utility ${app.getVersion()}`, click: () => send('menu:navigate', 'about') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
