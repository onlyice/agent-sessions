import { collectors } from './collectors'
import type { IndexDB, ScanCacheRow } from './db'
import type { AgentType, ScanCache, SessionMeta, Vault } from './types'

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'compacting' | 'done'
  agent?: AgentType
  indexed: number
  total: number
  /** On the 'done' event: whether this pass wrote or removed anything. */
  changed?: boolean
}

export interface IndexResult {
  /** Sessions whose transcript was (re)read and indexed. */
  indexed: number
  /** Sessions dropped because they no longer exist on disk. */
  removed: number
  /** Whether this pass wrote or removed anything at all. */
  changed: boolean
  /** Bytes handed back to the filesystem by a database rewrite, if one ran. */
  reclaimedBytes: number
  durationMs: number
}

/** At most one progress event per this many ms, so the UI isn't flooded. */
const PROGRESS_INTERVAL_MS = 150

/**
 * Remembers what each source file looked like the last time it was scanned, so
 * an unchanged file never has to be read and parsed again. This is what keeps a
 * periodic rescan cheap: without it every pass re-parses every transcript on
 * disk — gigabytes of JSONL — just to rediscover that nothing moved.
 */
class SessionScanCache implements ScanCache {
  private readonly upserts = new Map<string, ScanCacheRow>()
  private readonly seen = new Set<string>()

  constructor(private readonly entries: Map<string, ScanCacheRow>) {}

  get(sourcePath: string, fileMtime: number, fileSize: number): SessionMeta | undefined {
    this.seen.add(sourcePath)
    const row = this.entries.get(sourcePath)
    return row?.fileMtime === fileMtime && row.fileSize === fileSize ? row.meta : undefined
  }

  set(sourcePath: string, fileMtime: number, fileSize: number, meta: SessionMeta): void {
    this.seen.add(sourcePath)
    const row: ScanCacheRow = { fileMtime, fileSize, meta }
    this.entries.set(sourcePath, row)
    this.upserts.set(sourcePath, row)
  }

  get pendingWrites(): Map<string, ScanCacheRow> {
    return this.upserts
  }

  /** Remembered paths no collector looked at this pass — gone from disk. */
  get unseenPaths(): string[] {
    return [...this.entries.keys()].filter((path) => !this.seen.has(path))
  }
}

interface VaultScan {
  vault: Vault
  metas: SessionMeta[]
  /** Agents whose scan was incomplete; their existing rows must not be pruned. */
  partialAgents: Set<AgentType>
}

/** Scan every collector for one vault, tagging metas with the vault id. */
async function listVault(vault: Vault, cache: ScanCache): Promise<VaultScan> {
  const partialAgents = new Set<AgentType>()
  const scanned = (
    await Promise.all(
      (Object.keys(collectors) as AgentType[]).map(async (agent) => {
        try {
          const result = await collectors[agent].list(vault.home, cache)
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
  // Copied rather than mutated: these objects are owned by the scan cache and
  // are handed back unchanged on the next pass.
  const metas = scanned.map((m) => ({ ...m, vaultId: vault.id, id: `${vault.id}:${m.id}` }))
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
): Promise<IndexResult> {
  const startedAt = Date.now()
  onProgress?.({ phase: 'scanning', indexed: 0, total: 0 })

  const cache = new SessionScanCache(db.readScanCache())

  // Gather metadata for all vaults first so we know the total up front.
  const perVault = await Promise.all(vaults.map((vault) => listVault(vault, cache)))

  const stale = perVault.flatMap(({ vault, metas }) => {
    const indexed = db.indexedSessions(vault.id)
    return metas.filter((m) => {
      const row = indexed.get(m.id)
      return row?.mtime !== m.updatedAt || row.title !== m.title
    })
  })

  let indexed = 0
  let lastProgressAt = 0
  const total = stale.length

  for (const meta of stale) {
    try {
      const messages = await collectors[meta.agent].load(meta.sourcePath)
      db.upsertSession(meta, meta.updatedAt, messages)
    } catch (err) {
      console.error(`[indexer] failed to load ${meta.id}:`, err)
    }
    indexed++
    const now = Date.now()
    if (indexed === total || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      lastProgressAt = now
      onProgress?.({ phase: 'indexing', agent: meta.agent, indexed, total })
    }
  }

  // Prune sessions that no longer exist on disk, per vault. Agents that
  // reported a partial scan are left alone: a transient CLI or network failure
  // must never wipe an agent's history (and its search index) from the app.
  let removed = 0
  for (const { vault, metas, partialAgents } of perVault) {
    const seen = new Set(metas.map((m) => m.id))
    for (const [id, row] of db.indexedSessions(vault.id)) {
      if (seen.has(id) || partialAgents.has(row.agent)) continue
      db.removeSession(id)
      removed++
    }
  }

  // Forget cached scans of files nobody looked at — but only when every
  // collector reported a complete scan, so a transient failure doesn't throw
  // away work we'd have to redo.
  const complete = perVault.every(({ partialAgents }) => partialAgents.size === 0)
  db.writeScanCache(cache.pendingWrites, complete ? cache.unseenPaths : [])

  // Deletions above (and the sessions of any agent the app has dropped) only
  // free pages inside the file. Hand them back once enough have accumulated —
  // last, so this pass's own deletions are included, and here rather than at
  // startup because the indexer process can afford a multi-minute rewrite.
  let reclaimedBytes = 0
  if (db.compactionDue()) {
    onProgress?.({ phase: 'compacting', indexed, total })
    reclaimedBytes = db.compact()
  }

  const changed = total > 0 || removed > 0
  onProgress?.({ phase: 'done', indexed, total, changed })
  return { indexed, removed, changed, reclaimedBytes, durationMs: Date.now() - startedAt }
}
