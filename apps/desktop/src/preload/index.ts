import { contextBridge, ipcRenderer } from 'electron'

/**
 * The ONLY bridge between renderer and main. The renderer imports no Electron
 * API directly, which is what keeps it webview-agnostic and lets the legacy
 * channel be deleted later without touching UI code (brief §2).
 */

const api = {
  app: {
    info: (): Promise<{ version: string; channel: string; buildCode: string }> =>
      ipcRenderer.invoke('app:info')
  },
  files: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('files:pick')
  },
  invoice: {
    parse: (paths: string[]): Promise<unknown[]> =>
      ipcRenderer.invoke('invoice:parse', { paths })
  },
  export: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('export:pickDir'),
    run: (paths: string[], out: string, force = false): Promise<{ path: string }> =>
      ipcRenderer.invoke('export:run', { paths, out, force })
  },
  shell: {
    showItem: (path: string): Promise<void> => ipcRenderer.invoke('shell:showItem', path)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
