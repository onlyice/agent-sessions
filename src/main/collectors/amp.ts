import { promises as fs } from 'fs'
import { join } from 'path'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { asText, deriveTitle, flatten, toMillis, truncate } from './util'

const rootFor = (home: string): string => join(home, '.local', 'share', 'amp', 'threads')

function blocksFromAmp(content: any): Block[] {
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
      case 'tool_use':
        blocks.push({ kind: 'tool_use', toolName: c.name, toolCallId: c.id, toolInput: c.input })
        break
      case 'tool_result': {
        const text = asText(c.content ?? c.run?.content ?? c.output)
        blocks.push({ kind: 'tool_result', toolCallId: c.tool_use_id, text, isError: c.isError || c.is_error })
        break
      }
      default:
        break
    }
  }
  return blocks
}

function parseThread(thread: any): Message[] {
  const messages: Message[] = []
  let idx = 0
  for (const m of thread?.messages ?? []) {
    const blocks = blocksFromAmp(m.content)
    if (blocks.length === 0) continue
    const role: Role = m.role === 'assistant' ? 'assistant' : 'user'
    const text = flatten(blocks)
    if (!text) continue
    messages.push({
      idx: idx++,
      role,
      text,
      blocks,
      timestamp: toMillis(m.meta?.sentAt) ?? null
    })
  }
  return messages
}

export const ampCollector: Collector = {
  agent: 'amp',

  async list(home: string): Promise<SessionMeta[]> {
    const root = rootFor(home)
    let files: string[]
    try {
      files = (await fs.readdir(root)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: SessionMeta[] = []
    for (const file of files) {
      const path = join(root, file)
      try {
        const thread = JSON.parse(await fs.readFile(path, 'utf8'))
        const msgs = thread.messages ?? []
        if (msgs.length === 0) continue
        const stat = await fs.stat(path)
        const firstUser = msgs.find((m: any) => m.role === 'user')
        const firstText = firstUser ? asText(firstUser.content) : ''
        const created = toMillis(thread.created)
        const lastSent = toMillis(msgs[msgs.length - 1]?.meta?.sentAt)
        // cwd is not reliably stored in the thread; env may hold it.
        const cwd = thread.env?.initialWorkingDirectory ?? thread.env?.cwd ?? ''
        out.push({
          id: `amp:${thread.id}`,
          vaultId: '',
          agent: 'amp',
          nativeId: thread.id,
          cwd,
          title: deriveTitle(thread.title || firstText || truncate(thread.id, 60)),
          createdAt: created ?? stat.birthtimeMs,
          updatedAt: lastSent ?? stat.mtimeMs,
          messageCount: msgs.length,
          sourcePath: path,
          subAgents: []
        })
      } catch {
        /* ignore */
      }
    }
    return out
  },

  async load(path: string): Promise<Message[]> {
    try {
      return parseThread(JSON.parse(await fs.readFile(path, 'utf8')))
    } catch {
      return []
    }
  }
}
