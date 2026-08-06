import { contextBridge, ipcRenderer } from 'electron'

const api = {
  agentLabels: () => ipcRenderer.invoke('agents:labels'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string, options?: unknown) => ipcRenderer.invoke('session:get', id, options),
  loadSubAgent: (sourcePath: string, knownHash?: string) =>
    ipcRenderer.invoke('subagent:load', sourcePath, knownHash),
  search: (opts: unknown) => ipcRenderer.invoke('search', opts),
  stats: () => ipcRenderer.invoke('stats'),
  resume: (id: string) => ipcRenderer.invoke('resume', id),
  copyResumeCommand: (id: string) => ipcRenderer.invoke('resume:command', id),
  exportTranscriptHtml: (html: string, defaultPath: string) =>
    ipcRenderer.invoke('transcript:exportHtml', html, defaultPath),
  reindex: () => ipcRenderer.invoke('reindex'),
  listVaults: () => ipcRenderer.invoke('vaults:list'),
  pickVaultDir: () => ipcRenderer.invoke('vaults:pickDir'),
  addVault: (home: string, name: string) => ipcRenderer.invoke('vaults:add', home, name),
  removeVault: (id: string) => ipcRenderer.invoke('vaults:remove', id),
  renameVault: (id: string, name: string) => ipcRenderer.invoke('vaults:rename', id, name),
  setActiveVault: (id: string) => ipcRenderer.invoke('vaults:setActive', id),
  onReindexProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('reindex:progress', handler)
    return () => ipcRenderer.removeListener('reindex:progress', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
