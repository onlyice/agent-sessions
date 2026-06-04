import { contextBridge, ipcRenderer } from 'electron'

const api = {
  agentLabels: () => ipcRenderer.invoke('agents:labels'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string) => ipcRenderer.invoke('session:get', id),
  search: (opts: unknown) => ipcRenderer.invoke('search', opts),
  stats: () => ipcRenderer.invoke('stats'),
  resume: (id: string) => ipcRenderer.invoke('resume', id),
  copyResumeCommand: (id: string) => ipcRenderer.invoke('resume:command', id),
  reindex: () => ipcRenderer.invoke('reindex'),
  onReindexProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('reindex:progress', handler)
    return () => ipcRenderer.removeListener('reindex:progress', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
