import { contextBridge, ipcRenderer } from 'electron'

/**
 * The ONLY bridge between renderer and main. The renderer imports no Electron
 * API directly, which is what keeps it webview-agnostic and lets the legacy
 * channel be deleted later without touching UI code (brief §2).
 */

export interface AppInfo {
  version: string
  channel: string
  buildCode: string
  platform: string
  electron: string
  noticeVersion: number
}

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  confirmOnExit: boolean
  lastExportDir?: string
  consent?: { analytics: boolean; cloudSync: boolean; decidedAt: string; noticeVersion: number }
  needsConsent: boolean
}

export interface SheetDoc {
  kind: 'csv' | 'xlsx'
  sheets: { name: string; rows: string[][] }[]
  active: number
  truncated: boolean
  delimiter: string
  path: string
}

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
  exportPath?: string
  note?: string
  deletedAt?: string
}

export interface HistoryPage {
  items: HistoryRecord[]
  total: number
  page: number
  pageSize: number
}

export interface PathsInfo {
  base: string
  entries: string[]
}

export interface PublicAccount {
  id: string
  email: string
  name: string
  org?: string
  gstin?: string
  createdAt: string
  lastSignInAt?: string
}
export type AuthResult =
  | { ok: true; account: PublicAccount; recoveryCode?: string }
  | { ok: false; error: string; lockedForSeconds?: number }
export interface AuthStatus {
  hasAccount: boolean
  signedIn: boolean
  account: PublicAccount | null
}
export interface SyncStatus {
  enabled: boolean
  signedIn: boolean
  ready: boolean
  endpointConfigured: boolean
  pending: number
  pendingBytes: number
  lastBundleAt: string | null
  stagingDir: string
}
export interface SyncOutcome {
  status: 'uploaded' | 'staged' | 'skipped'
  reason?: string
  bytes?: number
  path?: string
}

const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  },
  auth: {
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    signUp: (input: {
      email: string
      password: string
      name: string
      org?: string
      gstin?: string
    }): Promise<AuthResult> => ipcRenderer.invoke('auth:signUp', input),
    signIn: (email: string, password: string): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:signIn', { email, password }),
    signOut: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:signOut'),
    reset: (email: string, recoveryCode: string, password: string): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:reset', { email, recoveryCode, password }),
    updateProfile: (patch: { name?: string; org?: string; gstin?: string }): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:updateProfile', patch),
    changePassword: (current: string, next: string): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:changePassword', { current, next })
  },
  sync: {
    status: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:status'),
    run: (): Promise<SyncOutcome> => ipcRenderer.invoke('sync:run'),
    probe: (): Promise<{ ok: boolean; reason: string }> => ipcRenderer.invoke('sync:probe'),
    serverSignIn: (email: string, password: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('sync:serverSignIn', { email, password }),
    listRemote: (): Promise<{ name: string; bytes: number; sha256: string; at: string }[]> =>
      ipcRenderer.invoke('sync:listRemote'),
    restore: (name: string): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke('sync:restore', { name })
  },
  history: {
    list: (options: {
      page?: number
      pageSize?: number
      query?: string
      includeDeleted?: boolean
    }): Promise<HistoryPage> => ipcRenderer.invoke('history:list', options),
    get: (id: string): Promise<HistoryRecord | null> => ipcRenderer.invoke('history:get', { id }),
    update: (
      id: string,
      patch: { note?: string; invoiceNo?: string; party?: string }
    ): Promise<HistoryRecord | null> => ipcRenderer.invoke('history:update', { id, ...patch }),
    remove: (id: string): Promise<HistoryRecord | null> =>
      ipcRenderer.invoke('history:remove', { id }),
    restore: (id: string): Promise<HistoryRecord | null> =>
      ipcRenderer.invoke('history:restore', { id }),
    download: (id: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke('history:download', { id })
  },
  paths: {
    info: (): Promise<PathsInfo> => ipcRenderer.invoke('paths:info'),
    pick: (): Promise<PathsInfo> => ipcRenderer.invoke('paths:pick'),
    reset: (): Promise<PathsInfo> => ipcRenderer.invoke('paths:reset'),
    reveal: (): Promise<void> => ipcRenderer.invoke('paths:reveal')
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<Pick<Settings, 'theme' | 'confirmOnExit'>>): Promise<Settings> =>
      ipcRenderer.invoke('settings:patch', patch),
    setConsent: (analytics: boolean, cloudSync: boolean): Promise<Settings> =>
      ipcRenderer.invoke('consent:set', { analytics, cloudSync })
  },
  files: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('files:pick')
  },
  invoice: {
    parse: (paths: string[]): Promise<unknown[]> => ipcRenderer.invoke('invoice:parse', { paths })
  },
  export: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('export:pickDir'),
    run: (paths: string[], out: string, force = false): Promise<{ path: string }> =>
      ipcRenderer.invoke('export:run', { paths, out, force })
  },
  sheet: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('sheet:pick'),
    read: (path: string): Promise<SheetDoc> => ipcRenderer.invoke('sheet:read', { path }),
    write: (
      path: string,
      sheets: { name: string; rows: string[][] }[],
      overwrite: boolean,
      delimiter: string
    ): Promise<{ path: string; overwrote: boolean }> =>
      ipcRenderer.invoke('sheet:write', { path, sheets, overwrite, delimiter })
  },
  feedback: {
    send: (
      kind: 'bug' | 'idea' | 'other',
      message: string,
      email: string
    ): Promise<{ status: 'queued' | 'failed'; queue?: string; error?: string }> =>
      ipcRenderer.invoke('feedback:send', { kind, message, email })
  },
  updates: {
    check: (): Promise<{ status: string; channel?: string }> => ipcRenderer.invoke('updates:check')
  },
  shell: {
    showItem: (path: string): Promise<void> => ipcRenderer.invoke('shell:showItem', path),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
