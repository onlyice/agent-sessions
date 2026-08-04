import { collectors } from './collectors'
import type { IndexDB } from './db'
import type { AgentType, SessionMeta, Vault } from './types'

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'done'
  agent?: AgentType
  indexed: number
  total: number
}

/** Scan every collector for one vault, tagging metas with the vault id. */
async function listVault(vault: Vault): Promise<SessionMeta[]> {
  const metas = (
    await Promise.all(
      (Object.keys(collectors) as AgentType[]).map(async (agent) => {
        try {
          return await collectors[agent].list(vault.home)
        } catch (err) {
          console.error(`[indexer] ${agent} list failed for vault ${vault.id}:`, err)
          return []
        }
      })
    )
  ).flat()
  // Namespace the id by vault so sessions from different vaults never collide.
  for (const m of metas) {
    m.vaultId = vault.id
    m.id = `${vault.id}:${m.id}`
  }
  return metas
}

/**
 * Incrementally sync on-disk sessions into the index for every vault.
 * A session is (re)indexed when it's new or its updatedAt changed; sessions
 * that disappeared from disk are removed. updatedAt doubles as a cheap version
 * marker (it advances as a transcript grows). Each vault is pruned in isolation
 * so removing/adding one vault never touches another's rows.
 */
export async function reindex(
  db: IndexDB,
  vaults: Vault[],
  onProgress?: (p: IndexProgress) => void
): Promise<{ sessions: number; messages: number }> {
  onProgress?.({ phase: 'scanning', indexed: 0, total: 0 })

  // Gather metadata for all vaults first so we know the total up front.
  const perVault = await Promise.all(
    vaults.map(async (v) => ({ vault: v, metas: await listVault(v) }))
  )

  const stale = perVault.flatMap(({ vault, metas }) => {
    const existing = db.indexedMtimes(vault.id)
    return metas.filter((m) => existing.get(m.id) !== m.updatedAt)
  })

  let indexed = 0
  const total = stale.length

  for (const meta of stale) {
    try {
      const collector = collectors[meta.agent]
      const messages = collector.loadOnDemand?.(meta.sourcePath)
        ? []
        : await collector.load(meta.sourcePath)
      db.upsertSession(meta, meta.updatedAt, messages)
    } catch (err) {
      console.error(`[indexer] failed to load ${meta.id}:`, err)
    }
    indexed++
    if (indexed % 5 === 0 || indexed === total) {
      onProgress?.({ phase: 'indexing', agent: meta.agent, indexed, total })
    }
  }

  // Prune sessions that no longer exist on disk, per vault.
  for (const { vault, metas } of perVault) {
    const seen = new Set(metas.map((m) => m.id))
    for (const id of db.indexedMtimes(vault.id).keys()) {
      if (!seen.has(id)) db.removeSession(id)
    }
  }

  onProgress?.({ phase: 'done', indexed, total })
  return db.stats()
}
