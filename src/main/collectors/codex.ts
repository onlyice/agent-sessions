import { promises as fs } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { deriveTitle, flatten, parseJsonl, stringify, toMillis, truncate } from './util'

const rootFor = (home: string): string => join(home, '.codex', 'sessions')

/** Read the latest generated or explicitly assigned name for each Codex thread. */
async function loadThreadNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  // Keep the append-only compatibility index as a fallback for older Codex
  // versions and threads that have not yet been imported into the state DB.
  try {
    const events = parseJsonl(await fs.readFile(join(home, '.codex', 'session_index.jsonl'), 'utf8'))
    for (const event of events) {
      if (
        typeof event.id === 'string' &&
        typeof event.thread_name === 'string' &&
        event.thread_name.trim()
      ) {
        // The index is append-only, so later entries supersede earlier names.
        names.set(event.id, event.thread_name)
      }
    }
  } catch {
    // Older Codex versions may not have a session index.
  }

  // Codex Desktop/IDE stores generated titles in the thread database. `name`
  // is an explicit/generated display name when present; legacy histories may
  // instead overwrite `title`, so support both schemas and prefer name.
  let db: Database.Database | undefined
  try {
    db = new Database(join(home, '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    const columns = new Set(
      (db.prepare("PRAGMA table_info('threads')").all() as { name: string }[]).map((c) => c.name)
    )
    if (columns.has('id') && columns.has('title')) {
      const rows = columns.has('name')
        ? (db
            .prepare('SELECT id, title, name FROM threads')
            .all() as { id: string; title: string; name: string | null }[])
        : (db
            .prepare('SELECT id, title, NULL AS name FROM threads')
            .all() as { id: string; title: string; name: null }[])
      for (const row of rows) {
        const title = row.name?.trim() || row.title?.trim()
        if (row.id && title) names.set(row.id, title)
      }
    }
  } catch {
    // The state DB is optional and its internal schema can vary by version.
  } finally {
    db?.close()
  }
  return names
}

/** Recursively collect rollout-*.jsonl files under the year/month/day tree. */
async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, acc)
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(p)
  }
}

function textFromContent(content: any): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' ? c.text ?? '' : typeof c === 'string' ? c : ''))
    .filter(Boolean)
    .join('\n')
}

function reasoningText(payload: any): string {
  const content =
    typeof payload.content === 'string' ? payload.content : textFromContent(payload.content)
  if (content.trim()) return content
  return Array.isArray(payload.summary)
    ? payload.summary
        .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
        .filter(Boolean)
        .join('\n')
    : ''
}

function parseCommandOutput(raw: string): { text: string; exitCode?: number } {
  const lines = raw.split('\n')
  const outputLineIndex = lines.findIndex((line, index) => index <= 8 && line === 'Output:')
  if (outputLineIndex < 0) return { text: raw }

  const header = lines.slice(0, outputLineIndex)
  const hasCodexOutputHeader = header.some((line) => /^Chunk ID: \S+/.test(line))
  if (!hasCodexOutputHeader) return { text: raw }

  const exitLine = header.find((line) => /^Process exited with code -?\d+$/.test(line))
  const exitCode = exitLine ? Number(exitLine.match(/-?\d+$/)?.[0]) : undefined
  return { text: lines.slice(outputLineIndex + 1).join('\n'), exitCode }
}

async function parse(path: string): Promise<Message[]> {
  const events = parseJsonl(await fs.readFile(path, 'utf8'))
  const messages: Message[] = []
  let idx = 0
  for (const ev of events) {
    if (ev.type !== 'response_item') continue
    const p = ev.payload
    if (!p) continue
    const ts = toMillis(ev.timestamp)

    if (p.type === 'message') {
      const role: Role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system'
      const text = textFromContent(p.content)
      if (!text.trim()) continue
      // The developer/system preamble is huge boilerplate; keep but mark as system.
      messages.push({ idx: idx++, role, text, blocks: [{ kind: 'text', text }], timestamp: ts })
    } else if (p.type === 'reasoning') {
      // Newer Codex rollouts usually retain only a readable summary and an
      // encrypted reasoning payload. Prefer full content when a version writes
      // it, then fall back to the summary; encrypted_content is not decryptable
      // by transcript consumers.
      const text = reasoningText(p)
      if (!text.trim()) continue
      messages.push({
        idx: idx++,
        role: 'thinking',
        text,
        blocks: [{ kind: 'thinking', text }],
        timestamp: ts
      })
    } else if (p.type === 'function_call') {
      let input: unknown = p.arguments
      try {
        input = JSON.parse(p.arguments)
      } catch {
        /* keep raw string */
      }
      const blocks: Block[] = [{ kind: 'tool_use', toolName: p.name, toolCallId: p.call_id, toolInput: input }]
      messages.push({ idx: idx++, role: 'tool', text: flatten(blocks), blocks, timestamp: ts })
    } else if (p.type === 'function_call_output') {
      const raw = typeof p.output === 'string' ? p.output : stringify(p.output)
      const { text: out, exitCode } = typeof p.output === 'string' ? parseCommandOutput(raw) : { text: raw }
      if (!out.trim() && exitCode == null) continue
      let toolResult: unknown
      try {
        toolResult = JSON.parse(raw)
      } catch {
        /* not all tool outputs are JSON */
      }
      const blocks: Block[] = [
        {
          kind: 'tool_result',
          text: out,
          toolCallId: p.call_id,
          toolResult,
          exitCode,
          isError: exitCode != null && exitCode !== 0 ? true : undefined
        }
      ]
      messages.push({
        idx: idx++,
        role: 'tool',
        text: out.trim() || (exitCode != null ? `Exit code ${exitCode}` : ''),
        blocks,
        timestamp: ts
      })
    }
  }
  return messages
}

export const codexCollector: Collector = {
  agent: 'codex',

  async list(home: string): Promise<SessionMeta[]> {
    const files: string[] = []
    const [threadNames] = await Promise.all([loadThreadNames(home), walk(rootFor(home), files)])
    const out: SessionMeta[] = []
    for (const path of files) {
      try {
        const stat = await fs.stat(path)
        if (stat.size === 0) continue
        const meta = await readMeta(path, stat.mtimeMs, threadNames)
        if (meta) out.push(meta)
      } catch {
        /* ignore */
      }
    }
    return out
  },

  load: parse
}

async function readMeta(
  path: string,
  mtime: number,
  threadNames: Map<string, string>
): Promise<SessionMeta | null> {
  const events = parseJsonl(await fs.readFile(path, 'utf8'))
  let id = ''
  let cwd = ''
  let createdAt: number | null = null
  let lastTs: number | null = null
  let firstUserText = ''
  let count = 0

  for (const ev of events) {
    if (ev.type === 'session_meta' && ev.payload) {
      id = ev.payload.id ?? id
      cwd = ev.payload.cwd ?? cwd
      createdAt = toMillis(ev.payload.timestamp) ?? createdAt
    }
    const ts = toMillis(ev.timestamp)
    if (ts) {
      if (createdAt == null) createdAt = ts
      lastTs = ts
    }
    if (ev.type === 'response_item' && ev.payload?.type === 'message') {
      const role = ev.payload.role
      if (role === 'assistant' || role === 'user') count++
      if (!firstUserText && role === 'user') {
        const t = textFromContent(ev.payload.content)
        // First real user turn (skip AGENTS.md / permission preamble).
        if (t && !t.startsWith('#') && !t.startsWith('<')) firstUserText = t
      }
    }
  }
  if (!id || count === 0) return null

  return {
    id: `codex:${id}`,
    vaultId: '',
    agent: 'codex',
    nativeId: id,
    cwd,
    title: deriveTitle(threadNames.get(id) || firstUserText || truncate(cwd, 60)),
    createdAt: createdAt ?? mtime,
    updatedAt: lastTs ?? mtime,
    messageCount: count,
    sourcePath: path,
    subAgents: []
  }
}
