import { ipcMain, BrowserWindow, clipboard, dialog } from 'electron'
import { collectors, AGENT_LABELS } from './collectors'
import type { IndexDB, SearchOptions } from './db'
import { reindex } from './indexer'
import { buildResumeCommand, resumeInGhostty } from './resume'
import {
  addVault,
  getActiveVaultId,
  getConfig,
  getVaults,
  removeVault,
  setActiveVault
} from './vaults'
import type { AgentType } from './types'

export function registerIpc(db: IndexDB, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('agents:labels', () => AGENT_LABELS)

  ipcMain.handle('sessions:list', async () => db.listSessions(await getActiveVaultId()))

  ipcMain.handle('session:get', async (_e, id: string) => {
    const meta = db.getSession(id)
    if (!meta) return null
    const messages = await collectors[meta.agent as AgentType].load(meta.sourcePath)
    return { meta, messages }
  })

  ipcMain.handle('search', async (_e, opts: SearchOptions) =>
    db.search({ ...opts, vaultId: await getActiveVaultId() })
  )

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
    const result = await reindex(db, await getVaults(), (p) => {
      getWindow()?.webContents.send('reindex:progress', p)
    })
    return result
  })

  // --- Vaults ---------------------------------------------------------------

  ipcMain.handle('vaults:list', () => getConfig())

  ipcMain.handle('vaults:add', async () => {
    const win = getWindow()
    const opts = {
      title: 'Add vault — pick a home directory',
      properties: ['openDirectory' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }

    const result = await addVault(res.filePaths[0])
    if (result.error) return { error: result.error }

    // Index the newly added vault in the background; the UI refreshes on 'done'.
    void reindex(db, await getVaults(), (p) => {
      getWindow()?.webContents.send('reindex:progress', p)
    }).catch((err) => console.error('[vaults] reindex after add failed:', err))

    return { config: result.config }
  })

  ipcMain.handle('vaults:remove', async (_e, id: string) => {
    const config = await removeVault(id)
    db.removeVaultSessions(id)
    return config
  })

  ipcMain.handle('vaults:setActive', (_e, id: string) => setActiveVault(id))
}
