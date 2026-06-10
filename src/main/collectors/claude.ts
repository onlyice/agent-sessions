import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { Block, Collector, Message, Role, SessionMeta, SubAgentMeta } from '../types'
import { HOME, asText, deriveTitle, flatten, parseJsonl, toMillis, truncate } from './util'

const ROOT = join(HOME, '.claude', 'projects')

/** Claude encodes the cwd into the project dir name by replacing / with -. */
function decodeCwd(dirName: string): string {
  // e.g. "-Users-kevin-lin-Project-foo" -> "/Users/kevin-lin/Project/foo"
  // The encoding is lossy (it can't distinguish - from /), so this is best-effort.
  return dirName.replace(/-/g, '/')
}

function blocksFromClaude(message: any): Block[] {
  const content = message?.content
  const blocks: Block[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
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
        blocks.push({ kind: 'tool_use', toolName: c.name, toolInput: c.input })
        break
      case 'tool_result': {
        const text = asText(c.content)
        blocks.push({ kind: 'tool_result', text, isError: !!c.is_error })
        break
      }
      case 'image':
        blocks.push({ kind: 'image', text: '[image]' })
        break
      default:
        break
    }
  }
  return blocks
}

async function parse(path: string): Promise<Message[]> {
  const raw = await fs.readFile(path, 'utf8')
  const events = parseJsonl(raw)
  const messages: Message[] = []
  let idx = 0
  for (const ev of events) {
    if (ev.type !== 'user' && ev.type !== 'assistant') continue
    const msg = ev.message
    if (!msg) continue
    // Skip synthetic/meta-only assistant entries with no usable content.
    const blocks = blocksFromClaude(msg)
    if (blocks.length === 0) continue
    // When a message consists purely of thinking blocks, label it as 'thinking'
    // rather than 'assistant' so the UI can render it with a distinct header.
    const allThinking = blocks.length > 0 && blocks.every((b) => b.kind === 'thinking')
    const role: Role = msg.role === 'assistant' ? (allThinking ? 'thinking' : 'assistant') : 'user'
    const text = flatten(blocks)
    if (!text) continue
    messages.push({
      idx: idx++,
      role,
      text,
      blocks,
      timestamp: toMillis(ev.timestamp),
      model: msg.model && msg.model !== '<synthetic>' ? msg.model : undefined
    })
  }
  return messages
}

export const claudeCollector: Collector = {
  agent: 'claude',

  async list(): Promise<SessionMeta[]> {
    let projectDirs: string[]
    try {
      projectDirs = await fs.readdir(ROOT)
    } catch {
      return []
    }
    const out: SessionMeta[] = []
    for (const dir of projectDirs) {
      const projDir = join(ROOT, dir)
      let files: string[]
      try {
        files = (await fs.readdir(projDir)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const file of files) {
        const path = join(projDir, file)
        try {
          const stat = await fs.stat(path)
          if (stat.size === 0) continue
          const meta = await readMeta(path, dir)
          if (meta) out.push(meta)
        } catch {
          // ignore unreadable file
        }
      }
    }
    return out
  },

  load: parse
}

/** Discover sub-agent JSONL files under {sessionId}/subagents/. */
async function discoverSubAgents(sessionDir: string): Promise<SubAgentMeta[]> {
  const subagentsDir = join(sessionDir, 'subagents')
  const results: SubAgentMeta[] = []

  async function scanDir(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      if (entry.endsWith('.jsonl') && entry.startsWith('agent-')) {
        try {
          const meta = await readSubAgentMeta(full)
          if (meta) results.push(meta)
        } catch {
          // skip unreadable
        }
      } else {
        try {
          const stat = await fs.stat(full)
          if (stat.isDirectory()) await scanDir(full)
        } catch {
          // skip
        }
      }
    }
  }

  await scanDir(subagentsDir)
  return results
}

async function readSubAgentMeta(path: string): Promise<SubAgentMeta | null> {
  const raw = await fs.readFile(path, 'utf8')
  const events = parseJsonl(raw)
  let firstUserText = ''
  let count = 0
  let agentId = ''

  for (const ev of events) {
    if (!agentId && ev.agentId) agentId = ev.agentId
    if (ev.type === 'user' || ev.type === 'assistant') {
      count++
      if (!firstUserText && ev.type === 'user' && ev.message) {
        const t = asText(ev.message.content)
        if (t) firstUserText = t
      }
    }
  }
  if (count === 0) return null

  const id = agentId || basename(path, '.jsonl').replace(/^agent-/, '')
  return {
    id,
    label: deriveTitle(firstUserText, id),
    sourcePath: path,
    messageCount: count
  }
}


/** Read lightweight metadata: scan first/last lines for cwd, sessionId, title. */
async function readMeta(path: string, dirName: string): Promise<SessionMeta | null> {
  const raw = await fs.readFile(path, 'utf8')
  const events = parseJsonl(raw)
  if (events.length === 0) return null

  const sessionId = basename(path, '.jsonl')
  let cwd = ''
  let firstUserText = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let count = 0

  for (const ev of events) {
    if (ev.cwd && !cwd) cwd = ev.cwd
    const ts = toMillis(ev.timestamp)
    if (ts) {
      if (firstTs == null) firstTs = ts
      lastTs = ts
    }
    if (ev.type === 'user' || ev.type === 'assistant') {
      count++
      if (!firstUserText && ev.type === 'user' && ev.message) {
        const t = asText(ev.message.content)
        // Skip command/tool-result-only user turns when picking a title.
        if (t && !t.startsWith('<')) firstUserText = t
      }
    }
  }
  if (count === 0) return null

  const stat = await fs.stat(path)
  const projDir = join(ROOT, dirName)
  const sessionDir = join(projDir, sessionId)
  const subAgents = await discoverSubAgents(sessionDir)
  return {
    id: `claude:${sessionId}`,
    agent: 'claude',
    nativeId: sessionId,
    cwd: cwd || decodeCwd(dirName),
    title: deriveTitle(firstUserText || truncate(decodeCwd(dirName), 60)),
    createdAt: firstTs ?? stat.birthtimeMs,
    updatedAt: lastTs ?? stat.mtimeMs,
    messageCount: count,
    sourcePath: path,
    subAgents
  }
}
