import { ipcMain, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { collectors, AGENT_LABELS } from './collectors'
import { hashMessages, type IndexDB, type SearchOptions } from './db'
import type { IndexService } from './index-service'
import { buildResumeCommand, resumeInGhostty } from './resume'
import {
  addVault,
  checkHome,
  getActiveVaultId,
  getConfig,
  getVaults,
  removeVault,
  renameVault,
  setActiveVault,
  suggestVaultName
} from './vaults'
import type { AgentType } from './types'

interface GetSessionOptions {
  /** Return the session header only, skipping transcript loading entirely. */
  metaOnly?: boolean
  /** Content hash the caller already holds; identical content is not resent. */
  knownHash?: string
}

export function registerIpc(
  db: IndexDB,
  indexer: IndexService,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('agents:labels', () => AGENT_LABELS)

  ipcMain.handle('sessions:list', async () => db.listSessions(await getActiveVaultId()))

  ipcMain.handle('session:get', async (_e, id: string, options: GetSessionOptions = {}) => {
    const meta = db.getSession(id)
    if (!meta) return null
    // Sub-agent views only need the parent's header, not its transcript.
    if (options.metaOnly) return { meta, messages: [], contentHash: '' }

    const messages = await collectors[meta.agent as AgentType].load(meta.sourcePath)
    const contentHash = hashMessages(messages)
    // A background refresh that changed nothing skips the (multi-MB) transfer.
    if (options.knownHash && options.knownHash === contentHash) {
      return { meta, messages: [], contentHash, unchanged: true }
    }
    return { meta, messages, contentHash }
  })

  ipcMain.handle('search', async (_e, opts: SearchOptions) =>
    db.search({ ...opts, vaultId: await getActiveVaultId() })
  )

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

  ipcMain.handle('transcript:exportHtml', async (_e, html: string, defaultPath: string) => {
    const win = getWindow()
    const opts = {
      title: 'Export transcript as HTML',
      defaultPath,
      filters: [{ name: 'HTML document', extensions: ['html'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { canceled: true }
    await writeFile(res.filePath, html, 'utf8')
    shell.showItemInFolder(res.filePath)
    return { canceled: false, filePath: res.filePath }
  })

  ipcMain.handle('subagent:load', async (_e, sourcePath: string, knownHash?: string) => {
    try {
      const messages = await collectors.claude.load(sourcePath)
      const contentHash = hashMessages(messages)
      if (knownHash && knownHash === contentHash) return { messages: [], contentHash, unchanged: true }
      return { messages, contentHash }
    } catch {
      return { messages: [], contentHash: '' }
    }
  })

  ipcMain.handle('reindex', async () => indexer.run(await getVaults()))

  // --- Vaults ---------------------------------------------------------------

  ipcMain.handle('vaults:list', () => getConfig())

  // Step 1: pick + validate a home directory, returning a suggested name.
  ipcMain.handle('vaults:pickDir', async () => {
    const win = getWindow()
    const opts = {
      title: 'Add vault — pick a home directory',
      properties: ['openDirectory' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }

    const home = res.filePaths[0]
    const error = await checkHome(home)
    if (error) return { error }
    return { home, suggestedName: suggestVaultName(home) }
  })

  // Step 2: add the vault under a (possibly user-edited) name and index it.
  ipcMain.handle('vaults:add', async (_e, home: string, name: string) => {
    const result = await addVault(home, name)
    if (result.error) return { error: result.error }

    // Index the newly added vault in the background; the UI refreshes on 'done'.
    void indexer
      .run(await getVaults())
      .catch((err) => console.error('[vaults] reindex after add failed:', err))

    return { config: result.config }
  })

  ipcMain.handle('vaults:remove', async (_e, id: string) => {
    const config = await removeVault(id)
    db.removeVaultSessions(id)
    return config
  })

  ipcMain.handle('vaults:rename', (_e, id: string, name: string) => renameVault(id, name))

  ipcMain.handle('vaults:setActive', (_e, id: string) => setActiveVault(id))
}
