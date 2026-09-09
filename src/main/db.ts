import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { statfsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname } from 'path'
import { SCAN_PARSER_VERSION } from './collectors'
import type { AgentType, Message, Role, SessionMeta, SubAgentMeta } from './types'

export interface IndexedSession {
  mtime: number
  title: string
  agent: AgentType
}

/**
 * A collector's last scan result for one source file. Building a SessionMeta
 * means reading and JSON-parsing the whole transcript, which is what makes a
 * rescan expensive; an unchanged (mtime, size) lets the collector skip it.
 */
export interface ScanCacheRow {
  fileMtime: number
  fileSize: number
  meta: SessionMeta
}

/**
 * Fingerprint a transcript's indexable content. Used to skip needless FTS
 * rewrites, and handed to the renderer so a background refresh can tell "same
 * transcript" without shipping (or stringifying) megabytes of messages.
 */
export function hashMessages(messages: Message[]): string {
  const h = createHash('sha1')
  for (const m of messages) {
    h.update(`${m.idx}|${m.role}|${m.timestamp ?? ''}|${m.blocks.length}|`)
    h.update(m.text)
    h.update('\u0000')
  }
  return h.digest('hex')
}

export interface SearchHit {
  sessionId: string
  agent: string
  title: string
  cwd: string
  idx: number
  role: Role
  timestamp: number | null
  snippet: string
  updatedAt: number
}

export interface SearchOptions {
  query: string
  roles?: Role[]
  agents?: string[]
  /** Restrict results to a single vault. */
  vaultId?: string
  limit?: number
}

/**
 * Deleting rows only returns their pages to SQLite's free list — the file keeps
 * the space forever unless it is rewritten. Dropping an agent's sessions, or
 * years of churn in a trigram index, can leave a lot stranded. These bounds
 * decide when a rewrite is worth its cost; both must be met, so a small
 * database is never rewritten over a rounding error and a large one is not
 * rewritten to reclaim a sliver.
 */
const COMPACT_MIN_FREE_BYTES = 128 * 1024 * 1024
const COMPACT_MIN_FREE_RATIO = 0.15

/**
 * VACUUM builds a complete second copy before it replaces the original, and the
 * rewrite passes through the WAL on the way. Refuse to start unless the volumes
 * involved can hold that comfortably: filling the user's disk to save some of
 * it back would be a bad trade.
 */
const COMPACT_DISK_HEADROOM = 2.5

export class IndexDB {
  private db: Database.Database
  /** Set when a rewrite failed, so it isn't retried every few minutes. */
  private compactionBroken = false

  constructor(private readonly path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    // The indexer runs in a separate process, so readers and the writer can
    // meet on the same file; wait for the lock instead of throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 10000')
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        vaultId     TEXT NOT NULL DEFAULT 'default',
        agent       TEXT NOT NULL,
        nativeId    TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        title       TEXT NOT NULL,
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL,
        messageCount INTEGER NOT NULL,
        sourcePath  TEXT NOT NULL,
        mtime       INTEGER NOT NULL,
        subAgents   TEXT NOT NULL DEFAULT '[]',
        contentHash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updatedAt DESC);
    `)

    const cols = this.db
      .prepare("PRAGMA table_info('sessions')")
      .all() as { name: string }[]

    // Migration: add subAgents column if missing (existing DBs).
    if (!cols.some((c) => c.name === 'subAgents')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN subAgents TEXT NOT NULL DEFAULT '[]'")
      // Force full reindex so existing sessions pick up sub-agent metadata.
      this.db.exec('UPDATE sessions SET mtime = 0')
    }

    // Migration: add vaultId column if missing. Pre-vault rows all belong to the
    // built-in 'default' vault (which mirrors HOME), so the default is correct.
    // The next reindex rewrites ids to the `${vaultId}:…` scheme and prunes the
    // old un-prefixed rows within the default scope — no full wipe needed.
    if (!cols.some((c) => c.name === 'vaultId')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN vaultId TEXT NOT NULL DEFAULT 'default'")
    }

    // Migration: add contentHash if missing. An empty hash never matches a real
    // one, so existing rows simply rewrite their FTS entries once.
    if (!cols.some((c) => c.name === 'contentHash')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN contentHash TEXT NOT NULL DEFAULT ''")
    }

    // Created after the migration above so the column is guaranteed to exist.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_vault ON sessions(vaultId)')

    // scan_cache holds nothing authoritative, so when its shape is out of date
    // recreating it beats migrating it — the only cost is one slow rescan.
    const scanCacheCols = this.db
      .prepare("PRAGMA table_info('scan_cache')")
      .all() as { name: string }[]
    if (scanCacheCols.length > 0 && !scanCacheCols.some((c) => c.name === 'parser')) {
      this.db.exec('DROP TABLE scan_cache')
    }

    this.db.exec(`
      -- Memo of the last successful scan of each source file. Not authoritative
      -- for anything the UI reads: dropping it only costs one slow rescan.
      CREATE TABLE IF NOT EXISTS scan_cache (
        sourcePath TEXT PRIMARY KEY,
        fileMtime  REAL NOT NULL,
        fileSize   INTEGER NOT NULL,
        parser     INTEGER NOT NULL,
        meta       TEXT NOT NULL
      );
    `)

    // Entries parsed by an older collector describe the file the old way; drop
    // them so the fix reaches files that haven't changed on disk.
    this.db.prepare('DELETE FROM scan_cache WHERE parser <> ?').run(SCAN_PARSER_VERSION)

    this.db.exec(`
      -- Trigram tokenizer => case-insensitive substring search that also works
      -- for CJK text (the default unicode61 tokenizer can't segment Chinese).
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        sessionId UNINDEXED,
        idx       UNINDEXED,
        role      UNINDEXED,
        timestamp UNINDEXED,
        tokenize = 'trigram'
      );
    `)

    // Amp support was removed, so drop its rows: the UI can no longer render or
    // resume that agent. Runs after messages_fts is guaranteed to exist.
    this.db.exec(`
      DELETE FROM messages_fts WHERE sessionId IN (SELECT id FROM sessions WHERE agent = 'amp');
      DELETE FROM scan_cache WHERE sourcePath IN (SELECT sourcePath FROM sessions WHERE agent = 'amp');
      DELETE FROM sessions WHERE agent = 'amp';
    `)
  }

  /**
   * Everything indexed in a vault, keyed by session id: `mtime` is the cheap
   * transcript version marker, `title` catches metadata-only renames, and
   * `agent` lets the indexer prune per collector.
   */
  indexedSessions(vaultId: string): Map<string, IndexedSession> {
    const rows = this.db
      .prepare('SELECT id, mtime, title, agent FROM sessions WHERE vaultId = ?')
      .all(vaultId) as (IndexedSession & { id: string })[]
    return new Map(rows.map((r) => [r.id, { mtime: r.mtime, title: r.title, agent: r.agent }]))
  }

  removeSession(id: string): void {
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(sid)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    })
    tx(id)
  }

  /** Remove every session (and its indexed messages) belonging to a vault. */
  removeVaultSessions(vaultId: string): void {
    const tx = this.db.transaction((vid: string) => {
      const ids = this.db
        .prepare('SELECT id FROM sessions WHERE vaultId = ?')
        .all(vid) as { id: string }[]
      const delMsg = this.db.prepare('DELETE FROM messages_fts WHERE sessionId = ?')
      for (const { id } of ids) delMsg.run(id)
      this.db.prepare('DELETE FROM sessions WHERE vaultId = ?').run(vid)
    })
    tx(vaultId)
  }

  /**
   * Insert or replace a session and all of its messages atomically. Rewriting
   * the FTS rows is by far the expensive part, so it is skipped when the
   * transcript's content hash is unchanged — a session can be re-upserted just
   * because its metadata moved, or because it was opened twice in the UI.
   */
  upsertSession(
    meta: SessionMeta,
    mtime: number,
    messages: Message[],
    contentHash = hashMessages(messages)
  ): void {
    const previous = this.db.prepare('SELECT contentHash FROM sessions WHERE id = ?').get(meta.id) as
      | { contentHash: string }
      | undefined
    const messagesUnchanged = previous != null && previous.contentHash === contentHash

    const insertSession = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, vaultId, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, mtime, subAgents, contentHash)
      VALUES (@id, @vaultId, @agent, @nativeId, @cwd, @title, @createdAt, @updatedAt, @messageCount, @sourcePath, @mtime, @subAgents, @contentHash)
    `)
    const insertMsg = this.db.prepare(`
      INSERT INTO messages_fts (text, sessionId, idx, role, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      insertSession.run({
        ...meta,
        mtime,
        contentHash,
        subAgents: JSON.stringify(meta.subAgents ?? [])
      })
      if (messagesUnchanged) return
      this.db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(meta.id)
      for (const m of messages) {
        if (!m.text) continue
        insertMsg.run(m.text, meta.id, m.idx, m.role, m.timestamp)
      }
    })
    tx()
  }

  /** Bytes SQLite is holding but no longer using, and the file's logical size. */
  private pageUsage(): { free: number; total: number } {
    const pageSize = this.db.pragma('page_size', { simple: true }) as number
    const pageCount = this.db.pragma('page_count', { simple: true }) as number
    const freeCount = this.db.pragma('freelist_count', { simple: true }) as number
    return { free: freeCount * pageSize, total: pageCount * pageSize }
  }

  /** Whether enough space is stranded in the file to be worth a rewrite. */
  compactionDue(): boolean {
    if (this.compactionBroken) return false
    const { free, total } = this.pageUsage()
    return free >= COMPACT_MIN_FREE_BYTES && free / total >= COMPACT_MIN_FREE_RATIO
  }

  /**
   * Rewrite the database, returning stranded pages to the filesystem. Reports
   * the bytes reclaimed, or 0 when it declined to run.
   *
   * Only ever call this from the indexer process: rewriting a multi-GB index
   * takes minutes, and on the main process that would freeze the window for the
   * duration. Readers on other connections keep seeing the pre-rewrite snapshot
   * through the WAL, so the app stays usable while it runs.
   */
  compact(): number {
    const { total } = this.pageUsage()
    // VACUUM's scratch copy is a temp file, which SQLite may place on a
    // different volume than the database itself; both need the headroom.
    const available = Math.min(availableBytes(dirname(this.path)), availableBytes(tmpdir()))
    if (available < total * COMPACT_DISK_HEADROOM) {
      console.warn(
        `[db] skipping compaction: needs ~${bytesToMb(total * COMPACT_DISK_HEADROOM)} MB free, ` +
          `have ${bytesToMb(available)} MB`
      )
      return 0
    }

    try {
      this.db.exec('VACUUM')
      // The rewrite went through the WAL, which is now as large as the database
      // was. Fold it back in so the space actually leaves the disk.
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      this.compactionBroken = true
      console.error('[db] compaction failed:', err)
      return 0
    }
    return Math.max(0, total - this.pageUsage().total)
  }

  /** Every remembered scan result, keyed by source path. */
  readScanCache(): Map<string, ScanCacheRow> {
    const rows = this.db
      .prepare('SELECT sourcePath, fileMtime, fileSize, meta FROM scan_cache')
      .all() as { sourcePath: string; fileMtime: number; fileSize: number; meta: string }[]
    const out = new Map<string, ScanCacheRow>()
    for (const row of rows) {
      try {
        out.set(row.sourcePath, {
          fileMtime: row.fileMtime,
          fileSize: row.fileSize,
          meta: JSON.parse(row.meta) as SessionMeta
        })
      } catch {
        // A corrupt entry just means one file gets rescanned.
      }
    }
    return out
  }

  /** Persist new/updated scan results and forget paths that vanished. */
  writeScanCache(upserts: Map<string, ScanCacheRow>, deletes: Iterable<string>): void {
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO scan_cache (sourcePath, fileMtime, fileSize, parser, meta)
       VALUES (?, ?, ?, ?, ?)`
    )
    const drop = this.db.prepare('DELETE FROM scan_cache WHERE sourcePath = ?')
    const tx = this.db.transaction(() => {
      for (const [path, row] of upserts) {
        put.run(path, row.fileMtime, row.fileSize, SCAN_PARSER_VERSION, JSON.stringify(row.meta))
      }
      for (const path of deletes) drop.run(path)
    })
    tx()
  }

  listSessions(vaultId: string): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT id, vaultId, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, subAgents
         FROM sessions WHERE vaultId = ? ORDER BY updatedAt DESC`
      )
      .all(vaultId) as (Omit<SessionMeta, 'subAgents'> & { subAgents: string })[]
    return rows.map(parseSubAgents)
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db
      .prepare(
        `SELECT id, vaultId, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, subAgents
         FROM sessions WHERE id = ?`
      )
      .get(id) as (Omit<SessionMeta, 'subAgents'> & { subAgents: string }) | undefined
    return row ? parseSubAgents(row) : undefined
  }

  search(opts: SearchOptions): SearchHit[] {
    const q = opts.query.trim()
    if (!q) return []
    const limit = opts.limit ?? 200

    // The trigram tokenizer can only match terms of length >= 3. Short terms
    // (very common in CJK, e.g. 2-char Chinese words) must use a LIKE scan.
    const terms = q.split(/\s+/).filter(Boolean)
    if (terms.some((t) => [...t].length < 3)) return this.searchLike(opts)

    const where: string[] = ['messages_fts MATCH ?']
    const params: unknown[] = [ftsQuery(q)]

    if (opts.vaultId) {
      where.push('s.vaultId = ?')
      params.push(opts.vaultId)
    }
    if (opts.roles?.length) {
      where.push(`role IN (${opts.roles.map(() => '?').join(',')})`)
      params.push(...opts.roles)
    }
    if (opts.agents?.length) {
      // agent is stored on the sessions table; join below.
      where.push(`s.agent IN (${opts.agents.map(() => '?').join(',')})`)
      params.push(...opts.agents)
    }

    const sql = `
      SELECT
        f.sessionId AS sessionId,
        s.agent AS agent,
        s.title AS title,
        s.cwd AS cwd,
        s.updatedAt AS updatedAt,
        f.idx AS idx,
        f.role AS role,
        f.timestamp AS timestamp,
        snippet(messages_fts, 0, '«', '»', '…', 16) AS snippet
      FROM messages_fts f
      JOIN sessions s ON s.id = f.sessionId
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `
    params.push(limit)
    try {
      return this.db.prepare(sql).all(...params) as SearchHit[]
    } catch {
      // Fall back to LIKE for very short queries the trigram index can't satisfy.
      return this.searchLike(opts)
    }
  }

  private searchLike(opts: SearchOptions): SearchHit[] {
    const terms = opts.query.trim().split(/\s+/).filter(Boolean)
    const where: string[] = []
    const params: unknown[] = []
    // AND a LIKE clause per term so multi-word queries still narrow results.
    for (const t of terms) {
      where.push('f.text LIKE ? ESCAPE ?')
      params.push(`%${escapeLike(t)}%`, '\\')
    }
    if (opts.vaultId) {
      where.push('s.vaultId = ?')
      params.push(opts.vaultId)
    }
    if (opts.roles?.length) {
      where.push(`f.role IN (${opts.roles.map(() => '?').join(',')})`)
      params.push(...opts.roles)
    }
    if (opts.agents?.length) {
      where.push(`s.agent IN (${opts.agents.map(() => '?').join(',')})`)
      params.push(...opts.agents)
    }
    const sql = `
      SELECT f.sessionId AS sessionId, s.agent AS agent, s.title AS title, s.cwd AS cwd,
             s.updatedAt AS updatedAt, f.idx AS idx, f.role AS role, f.timestamp AS timestamp,
             f.text AS snippet
      FROM messages_fts f JOIN sessions s ON s.id = f.sessionId
      WHERE ${where.join(' AND ')}
      ORDER BY s.updatedAt DESC
      LIMIT ?
    `
    params.push(opts.limit ?? 200)
    const rows = this.db.prepare(sql).all(...params) as SearchHit[]
    // Build a centered, «»-marked snippet around the first matching term so the
    // UI can highlight CJK / short-query matches the same way FTS results do.
    const first = terms[0] ?? ''
    for (const r of rows) r.snippet = makeSnippet(r.snippet, first)
    return rows
  }
}

/** Free space on the volume holding `dir`, or 0 when it can't be determined. */
function availableBytes(dir: string): number {
  try {
    const stats = statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    // Treating "unknown" as "no room" keeps a rewrite from starting blind.
    return 0
  }
}

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/** Build a safe FTS5 MATCH expression: phrase-quote each whitespace term (AND). */
function ftsQuery(q: string): string {
  const terms = q.split(/\s+/).filter(Boolean)
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

/** Escape LIKE wildcards in a user term (used with ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

function parseSubAgents(
  row: Omit<SessionMeta, 'subAgents'> & { subAgents: string }
): SessionMeta {
  let subAgents: SubAgentMeta[] = []
  try {
    subAgents = JSON.parse(row.subAgents)
  } catch {
    // ignore
  }
  return { ...row, subAgents }
}

/** Center a ~160-char window around the first match and wrap it in «». */
function makeSnippet(text: string, term: string): string {
  if (!term) return text.slice(0, 200)
  const pos = text.toLowerCase().indexOf(term.toLowerCase())
  if (pos < 0) return text.slice(0, 200)
  const start = Math.max(0, pos - 50)
  const end = Math.min(text.length, pos + term.length + 110)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const before = text.slice(start, pos)
  const match = text.slice(pos, pos + term.length)
  const after = text.slice(pos + term.length, end)
  return `${head}${before}«${match}»${after}${tail}`
}
