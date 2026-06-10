import Database from 'better-sqlite3'
import type { Message, Role, SessionMeta, SubAgentMeta } from './types'

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
  limit?: number
}

export class IndexDB {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        agent       TEXT NOT NULL,
        nativeId    TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        title       TEXT NOT NULL,
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL,
        messageCount INTEGER NOT NULL,
        sourcePath  TEXT NOT NULL,
        mtime       INTEGER NOT NULL,
        subAgents   TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updatedAt DESC);
    `)

    // Migration: add subAgents column if missing (existing DBs).
    const cols = this.db
      .prepare("PRAGMA table_info('sessions')")
      .all() as { name: string }[]
    if (!cols.some((c) => c.name === 'subAgents')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN subAgents TEXT NOT NULL DEFAULT '[]'")
      // Force full reindex so existing sessions pick up sub-agent metadata.
      this.db.exec('UPDATE sessions SET mtime = 0')
    }

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
  }

  /** Returns a map of sessionId -> mtime for everything currently indexed. */
  indexedMtimes(): Map<string, number> {
    const rows = this.db.prepare('SELECT id, mtime FROM sessions').all() as {
      id: string
      mtime: number
    }[]
    return new Map(rows.map((r) => [r.id, r.mtime]))
  }

  removeSession(id: string): void {
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(sid)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    })
    tx(id)
  }

  /** Insert or replace a session and all of its messages atomically. */
  upsertSession(meta: SessionMeta, mtime: number, messages: Message[]): void {
    const insertSession = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, mtime, subAgents)
      VALUES (@id, @agent, @nativeId, @cwd, @title, @createdAt, @updatedAt, @messageCount, @sourcePath, @mtime, @subAgents)
    `)
    const insertMsg = this.db.prepare(`
      INSERT INTO messages_fts (text, sessionId, idx, role, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(meta.id)
      insertSession.run({ ...meta, mtime, subAgents: JSON.stringify(meta.subAgents ?? []) })
      for (const m of messages) {
        if (!m.text) continue
        insertMsg.run(m.text, meta.id, m.idx, m.role, m.timestamp)
      }
    })
    tx()
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, subAgents
         FROM sessions ORDER BY updatedAt DESC`
      )
      .all() as (Omit<SessionMeta, 'subAgents'> & { subAgents: string })[]
    return rows.map(parseSubAgents)
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db
      .prepare(
        `SELECT id, agent, nativeId, cwd, title, createdAt, updatedAt, messageCount, sourcePath, subAgents
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

  stats(): { sessions: number; messages: number } {
    const sessions = (this.db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c
    const messages = (
      this.db.prepare('SELECT COUNT(*) c FROM messages_fts').get() as { c: number }
    ).c
    return { sessions, messages }
  }
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
