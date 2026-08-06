import { collectors } from './collectors'
import type { IndexDB } from './db'
import type { AgentType, SessionMeta, Vault } from './types'

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'done'
  agent?: AgentType
  indexed: number
  total: number
}

interface VaultScan {
  vault: Vault
  metas: SessionMeta[]
  /** Agents whose scan was incomplete; their existing rows must not be pruned. */
  partialAgents: Set<AgentType>
}

/** Scan every collector for one vault, tagging metas with the vault id. */
async function listVault(vault: Vault): Promise<VaultScan> {
  const partialAgents = new Set<AgentType>()
  const metas = (
    await Promise.all(
      (Object.keys(collectors) as AgentType[]).map(async (agent) => {
        try {
          const result = await collectors[agent].list(vault.home)
          if (result.partial) partialAgents.add(agent)
          return result.metas
        } catch (err) {
          console.error(`[indexer] ${agent} list failed for vault ${vault.id}:`, err)
          // A failed scan says nothing about what still exists on disk.
          partialAgents.add(agent)
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
  return { vault, metas, partialAgents }
}

/**
 * Incrementally sync on-disk sessions into the index for every vault.
 * A session is (re)indexed when it's new, its updatedAt changed, or its title
 * metadata changed; sessions that disappeared from disk are removed. updatedAt
 * doubles as a cheap transcript version marker. Each vault is pruned in
 * isolation so removing/adding one vault never touches another's rows.
 */
export async function reindex(
  db: IndexDB,
  vaults: Vault[],
  onProgress?: (p: IndexProgress) => void
): Promise<{ sessions: number; messages: number }> {
  onProgress?.({ phase: 'scanning', indexed: 0, total: 0 })

  // Gather metadata for all vaults first so we know the total up front.
  const perVault = await Promise.all(vaults.map(listVault))

  const stale = perVault.flatMap(({ vault, metas }) => {
    const indexed = db.indexedSessions(vault.id)
    return metas.filter((m) => {
      const row = indexed.get(m.id)
      return row?.mtime !== m.updatedAt || row.title !== m.title
    })
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

  // Prune sessions that no longer exist on disk, per vault. Agents that
  // reported a partial scan are left alone: a transient CLI or network failure
  // must never wipe an agent's history (and its search index) from the app.
  for (const { vault, metas, partialAgents } of perVault) {
    const seen = new Set(metas.map((m) => m.id))
    for (const [id, row] of db.indexedSessions(vault.id)) {
      if (seen.has(id) || partialAgents.has(row.agent)) continue
      db.removeSession(id)
    }
  }

  onProgress?.({ phase: 'done', indexed, total })
  return db.stats()
}
