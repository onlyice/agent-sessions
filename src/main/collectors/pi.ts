import { promises as fs } from 'fs'
import { join } from 'path'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { HOME, asText, deriveTitle, flatten, parseJsonl, toMillis, truncate } from './util'

const ROOT = join(HOME, '.pi', 'agent', 'sessions')

function blocksFromPi(content: any): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: Block[] = []
  for (const c of content) {
    if (!c || typeof c !== 'object') continue
    switch (c.type) {
      case 'text':
        if (c.text) blocks.push({ kind: 'text', text: c.text })
        break
      case 'thinking':
        if (c.thinking) blocks.push({ kind: 'thinking', text: c.thinking })
        break
      case 'toolCall':
      case 'tool_use':
        blocks.push({ kind: 'tool_use', toolName: c.name, toolInput: c.arguments ?? c.input })
        break
      case 'toolResult':
      case 'tool_result': {
        const text = asText(c.result ?? c.content ?? c.output)
        blocks.push({ kind: 'tool_result', text, isError: !!(c.isError || c.error) })
        break
      }
      default:
        break
    }
  }
  return blocks
}

async function parse(path: string): Promise<Message[]> {
  const events = parseJsonl(await fs.readFile(path, 'utf8'))
  const messages: Message[] = []
  let idx = 0
  for (const ev of events) {
    if (ev.type !== 'message' || !ev.message) continue
    const m = ev.message
    const blocks = blocksFromPi(m.content)
    if (blocks.length === 0) continue
    const role: Role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system'
    const text = flatten(blocks)
    if (!text) continue
    messages.push({
      idx: idx++,
      role,
      text,
      blocks,
      timestamp: toMillis(m.timestamp ?? ev.timestamp)
    })
  }
  return messages
}

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
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p)
  }
}

export const piCollector: Collector = {
  agent: 'pi',

  async list(): Promise<SessionMeta[]> {
    const files: string[] = []
    await walk(ROOT, files)
    const out: SessionMeta[] = []
    for (const path of files) {
      try {
        const stat = await fs.stat(path)
        if (stat.size === 0) continue
        const events = parseJsonl(await fs.readFile(path, 'utf8'))
        const head = events.find((e) => e.type === 'session')
        const id = head?.id
        if (!id) continue
        const cwd = head?.cwd ?? ''
        let firstUserText = ''
        let firstTs: number | null = toMillis(head?.timestamp)
        let lastTs: number | null = null
        let count = 0
        for (const ev of events) {
          if (ev.type !== 'message' || !ev.message) continue
          const role = ev.message.role
          if (role === 'user' || role === 'assistant') count++
          const ts = toMillis(ev.message.timestamp ?? ev.timestamp)
          if (ts) {
            if (firstTs == null) firstTs = ts
            lastTs = ts
          }
          if (!firstUserText && role === 'user') {
            const t = asText(ev.message.content)
            if (t) firstUserText = t
          }
        }
        if (count === 0) continue
        out.push({
          id: `pi:${id}`,
          agent: 'pi',
          nativeId: id,
          cwd,
          title: deriveTitle(firstUserText || truncate(cwd, 60)),
          createdAt: firstTs ?? stat.birthtimeMs,
          updatedAt: lastTs ?? stat.mtimeMs,
          messageCount: count,
          sourcePath: path,
          subAgents: []
        })
      } catch {
        /* ignore */
      }
    }
    return out
  },

  load: parse
}
