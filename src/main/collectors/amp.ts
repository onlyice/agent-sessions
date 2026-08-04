import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Block, Collector, Message, Role, SessionMeta } from '../types'
import { HOME, asText, deriveTitle, flatten, stringify, toMillis, truncate } from './util'

const rootFor = (home: string): string => join(home, '.local', 'share', 'amp', 'threads')
const cloudCacheRootFor = (home: string): string =>
  join(home, '.cache', 'agent-session-list', 'amp', 'threads')
const cloudUpdatedAt = new Map<string, number>()

function runAmp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'amp',
      args,
      { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

function cwdFromUri(uri: unknown): string {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return ''
  try {
    return fileURLToPath(uri)
  } catch {
    return ''
  }
}

function toolCallId(block: any): string | undefined {
  return block.toolUseId ?? block.toolUseID ?? block.tool_use_id ?? block.id
}

function toolResultValue(block: any): unknown {
  return block.result ?? block.run?.result ?? block.content ?? block.run?.content ?? block.output
}

function readableToolResult(block: any, result: unknown): string {
  const error = block.error?.message ?? block.run?.error?.message
  if (typeof error === 'string' && error) return error
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>
    for (const key of ['output', 'content', 'diff', 'message']) {
      if (typeof record[key] === 'string') return record[key]
    }
  }
  if (result != null) return stringify(result)

  const progressOutput = block.run?.progress?.output
  if (typeof progressOutput === 'string' && progressOutput) return progressOutput
  const reason = block.reason ?? block.run?.reason
  if (typeof reason === 'string' && reason) return reason
  const status = block.status ?? block.run?.status
  return typeof status === 'string' && status ? status : 'No output'
}

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
      case 'tool_call':
      case 'tool_use':
        blocks.push({
          kind: 'tool_use',
          toolName: c.name ?? c.toolName,
          toolCallId: toolCallId(c),
          toolInput: c.input
        })
        break
      case 'tool_result': {
        const result = toolResultValue(c)
        const status = c.status ?? c.run?.status
        blocks.push({
          kind: 'tool_result',
          toolName: c.toolName ?? c.name,
          toolCallId: toolCallId(c),
          text: readableToolResult(c, result),
          toolResult: result,
          exitCode:
            result && typeof result === 'object' && typeof (result as any).exitCode === 'number'
              ? (result as any).exitCode
              : undefined,
          isError:
            !!(c.isError || c.is_error) ||
            status === 'error' ||
            status === 'failed' ||
            status === 'rejected'
        })
        break
      }
      default:
        break
    }
  }
  return blocks
}

function timestampFromAmpMessage(message: any): number | null {
  const content = Array.isArray(message?.content) ? message.content : []
  return (
    toMillis(message?.meta?.sentAt) ??
    toMillis(message?.timestamp) ??
    toMillis(message?.usage?.timestamp) ??
    toMillis(content.find((block: any) => block?.startTime != null)?.startTime) ??
    null
  )
}

function parseThread(thread: any): Message[] {
  const messages: Message[] = []
  const toolNames = new Map<string, string>()
  let idx = 0
  for (const m of thread?.messages ?? []) {
    const blocks = blocksFromAmp(m.content)
    for (const file of m.fileMentions?.files ?? []) {
      if (!file?.uri) continue
      blocks.push({ kind: file.isImage ? 'image' : 'file', text: file.uri })
    }
    if (blocks.length === 0) continue
    for (const block of blocks) {
      if (block.kind === 'tool_use' && block.toolCallId && block.toolName) {
        toolNames.set(block.toolCallId, block.toolName)
      } else if (block.kind === 'tool_result' && block.toolCallId && !block.toolName) {
        block.toolName = toolNames.get(block.toolCallId)
      }
    }
    const role: Role = m.role === 'assistant' ? 'assistant' : 'user'
    const text = flatten(blocks)
    if (!text) continue
    messages.push({
      idx: idx++,
      role,
      text,
      blocks,
      timestamp: timestampFromAmpMessage(m),
      model: m.usage?.model
    })
  }
  return messages
}

interface CloudCache {
  remoteUpdatedAt: number
  thread: unknown
}

async function loadCloudThread(path: string): Promise<any> {
  const expectedUpdatedAt = cloudUpdatedAt.get(path)
  try {
    const cached = JSON.parse(await fs.readFile(path, 'utf8')) as CloudCache
    if (
      cached &&
      cached.thread &&
      (expectedUpdatedAt == null || cached.remoteUpdatedAt === expectedUpdatedAt)
    ) {
      return cached.thread
    }
  } catch {
    // Missing, stale, or malformed caches are refreshed from Amp below.
  }

  const nativeId = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
  const thread = JSON.parse(await runAmp(['threads', 'export', nativeId]))
  await fs.mkdir(cloudCacheRootFor(HOME), { recursive: true })
  const cache: CloudCache = { remoteUpdatedAt: expectedUpdatedAt ?? Date.now(), thread }
  await fs.writeFile(path, JSON.stringify(cache))
  return thread
}

async function listCloudThreads(home: string): Promise<SessionMeta[]> {
  // Amp credentials and server threads belong to the current OS user. Added
  // vaults still scan their own on-disk transcript directories only.
  if (home !== HOME) return []

  const raw = await runAmp(['threads', 'list', '--json', '--limit', '100'])
  const threads = JSON.parse(raw)
  if (!Array.isArray(threads)) return []

  const cacheRoot = cloudCacheRootFor(home)
  return threads.flatMap((thread: any): SessionMeta[] => {
    if (!thread?.id) return []
    const updatedAt = toMillis(thread.updated) ?? 0
    const sourcePath = join(cacheRoot, `${thread.id}.json`)
    cloudUpdatedAt.set(sourcePath, updatedAt)
    return [
      {
        id: `amp:${thread.id}`,
        vaultId: '',
        agent: 'amp',
        nativeId: thread.id,
        cwd: cwdFromUri(thread.tree),
        title: deriveTitle(thread.title || thread.id),
        createdAt: updatedAt,
        updatedAt,
        messageCount: typeof thread.messageCount === 'number' ? thread.messageCount : 0,
        sourcePath,
        subAgents: []
      }
    ]
  })
}

export const ampCollector: Collector = {
  agent: 'amp',

  async list(home: string): Promise<SessionMeta[]> {
    const root = rootFor(home)
    let files: string[] = []
    try {
      files = (await fs.readdir(root)).filter((f) => f.endsWith('.json'))
    } catch {
      // Newer Amp versions keep canonical transcripts on the server, so the
      // absence of the legacy local directory is not an error.
    }
    const out: SessionMeta[] = []
    for (const file of files) {
      const path = join(root, file)
      try {
        const thread = JSON.parse(await fs.readFile(path, 'utf8'))
        const msgs = thread.messages ?? []
        if (msgs.length === 0) continue
        const stat = await fs.stat(path)
        const firstUser = msgs.find(
          (m: any) =>
            (m.kind === 'user' || (m.kind == null && m.role === 'user')) &&
            !m.content?.every?.((block: any) => block?.type === 'tool_result')
        )
        const firstText = firstUser ? asText(firstUser.content) : ''
        const created = toMillis(thread.created)
        const lastSent = msgs
          .map(timestampFromAmpMessage)
          .findLast((timestamp: number | null) => timestamp != null)
        // cwd is not reliably stored in the thread; env may hold it.
        const treePath = cwdFromUri(thread.env?.initial?.trees?.[0]?.uri)
        const cwd = thread.env?.initialWorkingDirectory ?? thread.env?.cwd ?? treePath
        out.push({
          id: `amp:${thread.id}`,
          vaultId: '',
          agent: 'amp',
          nativeId: thread.id,
          cwd,
          title: deriveTitle(thread.title || firstText || truncate(thread.id, 60)),
          createdAt: created ?? stat.birthtimeMs,
          // Tool-result turns often have no timestamp, so mtime must remain part
          // of the version marker while an active transcript is still growing.
          updatedAt: Math.max(lastSent ?? 0, stat.mtimeMs),
          messageCount: msgs.length,
          sourcePath: path,
          subAgents: []
        })
      } catch {
        /* ignore */
      }
    }
    try {
      const localIds = new Set(out.map((session) => session.nativeId))
      const cloud = await listCloudThreads(home)
      out.push(...cloud.filter((session) => !localIds.has(session.nativeId)))
    } catch (err) {
      console.error('[amp] failed to list server threads:', err)
    }
    return out
  },

  async load(path: string): Promise<Message[]> {
    try {
      const isCloudCache = path.startsWith(cloudCacheRootFor(HOME) + '/')
      const thread = isCloudCache
        ? await loadCloudThread(path)
        : JSON.parse(await fs.readFile(path, 'utf8'))
      return parseThread(thread)
    } catch {
      return []
    }
  },

  loadOnDemand(path: string): boolean {
    return path.startsWith(cloudCacheRootFor(HOME) + '/')
  }
}
