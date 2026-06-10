import { promises as fs } from 'fs'
import { join } from 'path'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { HOME, deriveTitle, flatten, stringify, toMillis, truncate } from './util'

const ROOT = join(HOME, '.local', 'share', 'opencode', 'storage')
const SESSION_DIR = join(ROOT, 'session')
const MESSAGE_DIR = join(ROOT, 'message')
const PART_DIR = join(ROOT, 'part')

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

function blocksFromPart(part: any): Block[] {
  // OpenCode writes a `synthetic` text part next to every real part (e.g.
  // "Called the Read tool with the following input: {…}"). These duplicate the
  // structured tool/file parts and are the main source of transcript clutter,
  // so drop them entirely.
  if (part?.synthetic) return []
  switch (part?.type) {
    case 'text':
      return part.text ? [{ kind: 'text', text: part.text }] : []
    case 'reasoning':
      return part.text ? [{ kind: 'thinking', text: part.text }] : []
    case 'tool': {
      const state = part.state ?? {}
      const blocks: Block[] = [
        { kind: 'tool_use', toolName: part.tool, toolInput: state.input }
      ]
      // state.output holds the tool result for completed calls; some tools also
      // stash a human-readable string under state.metadata.output.
      const output = state.output ?? state.metadata?.output
      const isError = state.status === 'error' || !!state.error
      const errText = isError ? state.error ?? output : output
      if (errText && stringify(errText).trim()) {
        blocks.push({
          kind: 'tool_result',
          text: typeof errText === 'string' ? errText : stringify(errText),
          isError
        })
      }
      return blocks
    }
    case 'file':
      return [{ kind: 'file', text: part.filename ?? part.url ?? 'file' }]
    // step-start / step-finish / snapshot / patch carry no transcript content.
    default:
      return []
  }
}

/** Sort by embedded sortable id (ULID-ish) which is monotonic with creation. */
function byId(a: { id?: string }, b: { id?: string }): number {
  return (a.id ?? '').localeCompare(b.id ?? '')
}

async function parse(sessionPath: string): Promise<Message[]> {
  // sessionPath is the session json; derive sessionID from its content.
  const session = await readJson(sessionPath)
  if (!session?.id) return []
  const msgDir = join(MESSAGE_DIR, session.id)
  const msgFiles = await listFiles(msgDir)
  const rawMessages = (
    await Promise.all(msgFiles.map((f) => readJson(join(msgDir, f))))
  ).filter(Boolean) as any[]
  rawMessages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || byId(a, b))

  const messages: Message[] = []
  let idx = 0
  for (const m of rawMessages) {
    const partFiles = await listFiles(join(PART_DIR, m.id))
    const parts = (
      await Promise.all(partFiles.map((f) => readJson(join(PART_DIR, m.id, f))))
    ).filter(Boolean) as any[]
    parts.sort(byId)

    const blocks: Block[] = []
    for (const p of parts) blocks.push(...blocksFromPart(p))
    if (blocks.length === 0) continue

    const role: Role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system'
    const text = flatten(blocks)
    if (!text) continue
    messages.push({
      idx: idx++,
      role,
      text,
      blocks,
      timestamp: toMillis(m.time?.created),
      model: m.modelID ?? m.model?.modelID
    })
  }
  return messages
}

export const opencodeCollector: Collector = {
  agent: 'opencode',

  async list(): Promise<SessionMeta[]> {
    let projectDirs: string[]
    try {
      projectDirs = await fs.readdir(SESSION_DIR)
    } catch {
      return []
    }
    const out: SessionMeta[] = []
    for (const proj of projectDirs) {
      const dir = join(SESSION_DIR, proj)
      for (const file of await listFiles(dir)) {
        const path = join(dir, file)
        const s = await readJson(path)
        if (!s?.id) continue
        // messageCount: count files in the message dir (cheap, no parse).
        const msgCount = (await listFiles(join(MESSAGE_DIR, s.id))).length
        if (msgCount === 0) continue
        out.push({
          id: `opencode:${s.id}`,
          agent: 'opencode',
          nativeId: s.id,
          cwd: s.directory ?? '',
          title: deriveTitle(s.title || truncate(s.directory ?? '', 60)),
          createdAt: toMillis(s.time?.created) ?? Date.now(),
          updatedAt: toMillis(s.time?.updated) ?? toMillis(s.time?.created) ?? Date.now(),
          messageCount: msgCount,
          sourcePath: path,
          subAgents: []
        })
      }
    }
    return out
  },

  load: parse
}
