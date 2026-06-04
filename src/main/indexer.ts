import { collectors } from './collectors'
import type { IndexDB } from './db'
import type { AgentType } from './types'

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'done'
  agent?: AgentType
  indexed: number
  total: number
}

/**
 * Incrementally sync on-disk sessions into the index.
 * A session is (re)indexed when it's new or its updatedAt changed; sessions
 * that disappeared from disk are removed. updatedAt doubles as a cheap version
 * marker (it advances as a transcript grows).
 */
export async function reindex(
  db: IndexDB,
  onProgress?: (p: IndexProgress) => void
): Promise<{ sessions: number; messages: number }> {
  const existing = db.indexedMtimes()
  const seen = new Set<string>()

  onProgress?.({ phase: 'scanning', indexed: 0, total: 0 })

  // Gather metadata from all collectors first so we know the total.
  const allMetas = (
    await Promise.all(
      (Object.keys(collectors) as AgentType[]).map(async (agent) => {
        try {
          return await collectors[agent].list()
        } catch (err) {
          console.error(`[indexer] ${agent} list failed:`, err)
          return []
        }
      })
    )
  ).flat()

  const stale = allMetas.filter((m) => existing.get(m.id) !== m.updatedAt)
  let indexed = 0
  const total = stale.length

  for (const meta of allMetas) seen.add(meta.id)

  for (const meta of stale) {
    try {
      const messages = await collectors[meta.agent].load(meta.sourcePath)
      db.upsertSession(meta, meta.updatedAt, messages)
    } catch (err) {
      console.error(`[indexer] failed to load ${meta.id}:`, err)
    }
    indexed++
    if (indexed % 5 === 0 || indexed === total) {
      onProgress?.({ phase: 'indexing', agent: meta.agent, indexed, total })
    }
  }

  // Prune sessions that no longer exist on disk.
  for (const id of existing.keys()) {
    if (!seen.has(id)) db.removeSession(id)
  }

  onProgress?.({ phase: 'done', indexed, total })
  return db.stats()
}
