import { ipcMain, BrowserWindow, clipboard } from 'electron'
import { collectors, AGENT_LABELS } from './collectors'
import type { IndexDB, SearchOptions } from './db'
import { reindex } from './indexer'
import { buildResumeCommand, resumeInGhostty } from './resume'
import type { AgentType } from './types'

export function registerIpc(db: IndexDB, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('agents:labels', () => AGENT_LABELS)

  ipcMain.handle('sessions:list', () => db.listSessions())

  ipcMain.handle('session:get', async (_e, id: string) => {
    const meta = db.getSession(id)
    if (!meta) return null
    const messages = await collectors[meta.agent as AgentType].load(meta.sourcePath)
    return { meta, messages }
  })

  ipcMain.handle('search', (_e, opts: SearchOptions) => db.search(opts))

  ipcMain.handle('stats', () => db.stats())

  ipcMain.handle('resume', async (_e, id: string) => {
    const meta = db.getSession(id)
    if (!meta) return { ok: false, command: '', error: 'session not found' }
    return resumeInGhostty(meta)
  })

  ipcMain.handle('resume:command', (_e, id: string) => {
    const meta = db.getSession(id)
    if (!meta) return ''
    const cmd = buildResumeCommand(meta)
    clipboard.writeText(cmd)
    return cmd
  })

  ipcMain.handle('subagent:load', async (_e, sourcePath: string) => {
    try {
      const messages = await collectors.claude.load(sourcePath)
      return { messages }
    } catch {
      return { messages: [] }
    }
  })

  ipcMain.handle('reindex', async () => {
    const result = await reindex(db, (p) => {
      getWindow()?.webContents.send('reindex:progress', p)
    })
    return result
  })
}
