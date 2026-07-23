import { promises as fs } from 'fs'
import { join } from 'path'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { deriveTitle, flatten, parseJsonl, stringify, toMillis, truncate } from './util'

const rootFor = (home: string): string => join(home, '.codex', 'sessions')

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
      const summary = Array.isArray(p.summary)
        ? p.summary.map((s: any) => (typeof s === 'string' ? s : s?.text ?? '')).join('\n')
        : ''
      const text = summary || (typeof p.content === 'string' ? p.content : '')
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
      const blocks: Block[] = [
        {
          kind: 'tool_result',
          text: out,
          toolCallId: p.call_id,
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
    await walk(rootFor(home), files)
    const out: SessionMeta[] = []
    for (const path of files) {
      try {
        const stat = await fs.stat(path)
        if (stat.size === 0) continue
        const meta = await readMeta(path, stat.mtimeMs)
        if (meta) out.push(meta)
      } catch {
        /* ignore */
      }
    }
    return out
  },

  load: parse
}

async function readMeta(path: string, mtime: number): Promise<SessionMeta | null> {
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
    title: deriveTitle(firstUserText || truncate(cwd, 60)),
    createdAt: createdAt ?? mtime,
    updatedAt: lastTs ?? mtime,
    messageCount: count,
    sourcePath: path,
    subAgents: []
  }
}
