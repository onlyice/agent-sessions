import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Block, Collector, ListResult, Message, Role, SessionMeta } from '../types'
import { resolveBin } from '../user-path'
import { HOME, asText, deriveTitle, flatten, mapLimit, stringify, toMillis, truncate } from './util'

const rootFor = (home: string): string => join(home, '.local', 'share', 'amp', 'threads')
const cloudCacheRootFor = (home: string): string =>
  join(home, '.cache', 'agent-session-list', 'amp', 'threads')

/** `updated` reported by the last successful `amp threads list`, per cache path. */
const cloudUpdatedAt = new Map<string, number>()

/**
 * Page through `amp threads list` until the server runs out. A request costs
 * the same whatever the limit (CLI startup plus one round trip dominates), so
 * the page is large and extra pages are the rare-case fallback.
 */
const CLOUD_PAGE_SIZE = 500
const CLOUD_MAX_THREADS = 5000

async function runAmp(args: string[]): Promise<string> {
  // Resolved explicitly: a packaged app's PATH doesn't contain ~/.local/bin.
  const bin = process.env.AMP_BIN || (await resolveBin('amp'))
  return new Promise((resolve, reject) => {
    execFile(
      bin,
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

// --- Cloud threads ----------------------------------------------------------

interface CloudCache {
  /** `updated` from `amp threads list` at the time of the export. */
  remoteUpdatedAt: number
  /** The thread's own `updatedAt`, which — unlike the above — assistant turns move. */
  threadUpdatedAt?: number
  thread: unknown
}

async function readCloudCache(path: string): Promise<CloudCache | undefined> {
  try {
    const candidate = JSON.parse(await fs.readFile(path, 'utf8')) as CloudCache
    return candidate?.thread ? candidate : undefined
  } catch {
    // Missing or malformed caches are refreshed from Amp.
    return undefined
  }
}

/**
 * `amp threads list` reports `updated` as the *last user message* time, so it
 * can't tell us an assistant turn landed afterwards. A cached export is only
 * provably current when it was captured at or after that timestamp *and* Amp had
 * gone idle — any later work has to start with a new user message, which moves
 * `updated` again and invalidates the cache the normal way.
 */
function isCurrent(cache: CloudCache, listUpdatedAt: number | undefined): boolean {
  if (listUpdatedAt == null || cache.remoteUpdatedAt !== listUpdatedAt) return false
  const thread = cache.thread as any
  const capturedAt = cache.threadUpdatedAt ?? toMillis(thread?.updatedAt)
  if (capturedAt == null || capturedAt < listUpdatedAt) return false
  return thread?.meta?.lastKnownAgentState?.state === 'idle'
}

async function loadCloudThread(
  path: string,
  options?: { fresh?: boolean; allowStale?: boolean }
): Promise<any> {
  const expectedUpdatedAt = cloudUpdatedAt.get(path)
  const cached = await readCloudCache(path)
  // allowStale opens instantly from disk; otherwise only a provably current
  // cache may skip the ~1.5s CLI round trip — even for an explicit refresh.
  if (cached && (options?.allowStale || isCurrent(cached, expectedUpdatedAt))) {
    return cached.thread
  }

  const nativeId = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
  let thread: any
  try {
    thread = JSON.parse(await runAmp(['threads', 'export', nativeId]))
  } catch (err) {
    // A refresh should not blank an already available transcript just because
    // Amp is temporarily offline or an export fails.
    if (cached) return cached.thread
    throw err
  }
  try {
    await fs.mkdir(cloudCacheRootFor(HOME), { recursive: true })
    const nextCache: CloudCache = {
      // The export carries the same timestamp the listing reports, so a cache
      // written before any listing still validates itself later.
      remoteUpdatedAt: expectedUpdatedAt ?? toMillis(thread?.meta?.lastUserMessageAt) ?? 0,
      threadUpdatedAt: toMillis(thread?.updatedAt) ?? undefined,
      thread
    }
    await fs.writeFile(path, JSON.stringify(nextCache))
  } catch (err) {
    // The fresh export is still usable even if its local cache cannot be saved.
    console.error('[amp] failed to cache server thread:', err)
  }
  return thread
}

/** Drop cached exports for threads the server no longer lists (deleted/archived). */
async function evictOrphanCaches(cacheRoot: string, live: Set<string>): Promise<void> {
  try {
    const files = await fs.readdir(cacheRoot)
    await Promise.all(
      files
        .filter((file) => file.endsWith('.json') && !live.has(file.slice(0, -'.json'.length)))
        .map((file) => fs.rm(join(cacheRoot, file), { force: true }))
    )
  } catch {
    // Nothing cached yet, or the cache dir is unreadable — nothing to reclaim.
  }
}

async function listCloudThreads(home: string): Promise<SessionMeta[]> {
  // Amp credentials and server threads belong to the current OS user. Added
  // vaults still scan their own on-disk transcript directories only.
  if (home !== HOME) return []

  const cacheRoot = cloudCacheRootFor(home)
  const out: SessionMeta[] = []
  const seen = new Set<string>()
  let complete = false

  for (let offset = 0; offset < CLOUD_MAX_THREADS; offset += CLOUD_PAGE_SIZE) {
    const page = JSON.parse(
      await runAmp([
        'threads',
        'list',
        '--json',
        '--limit',
        String(CLOUD_PAGE_SIZE),
        '--offset',
        String(offset)
      ])
    )
    if (!Array.isArray(page) || page.length === 0) {
      complete = true
      break
    }

    const before = seen.size
    for (const thread of page) {
      if (!thread?.id || seen.has(thread.id)) continue
      seen.add(thread.id)
      const updatedAt = toMillis(thread.updated) ?? 0
      const sourcePath = join(cacheRoot, `${thread.id}.json`)
      cloudUpdatedAt.set(sourcePath, updatedAt)
      out.push({
        id: `amp:${thread.id}`,
        vaultId: '',
        agent: 'amp',
        nativeId: thread.id,
        cwd: cwdFromUri(thread.tree),
        title: deriveTitle(thread.title || thread.id),
        // The listing has no creation time; the thread's own `created` is only
        // available once exported, and nothing in the UI reads createdAt.
        createdAt: updatedAt,
        updatedAt,
        messageCount: typeof thread.messageCount === 'number' ? thread.messageCount : 0,
        sourcePath,
        subAgents: []
      })
    }
    // A server that ignores --offset would repeat page one forever.
    if (page.length < CLOUD_PAGE_SIZE || seen.size === before) {
      complete = true
      break
    }
  }

  if (complete) void evictOrphanCaches(cacheRoot, seen)
  else console.warn(`[amp] stopped listing server threads at ${CLOUD_MAX_THREADS}`)
  return out
}

// --- Local threads ----------------------------------------------------------

interface LocalEntry {
  mtimeMs: number
  size: number
  /** Null for files with no usable messages, so they aren't re-parsed either. */
  meta: SessionMeta | null
}

/**
 * Parsing every legacy thread file on each scan costs ~14MB of JSON for metadata
 * that only changes when the file does. Keyed by path, validated by mtime+size.
 */
const localCache = new Map<string, LocalEntry>()

async function readLocalThread(path: string): Promise<LocalEntry | null> {
  const stat = await fs.stat(path)
  const hit = localCache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit

  const thread = JSON.parse(await fs.readFile(path, 'utf8'))
  const msgs = thread.messages ?? []
  let meta: SessionMeta | null = null
  if (msgs.length > 0) {
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
    meta = {
      id: `amp:${thread.id}`,
      vaultId: '',
      agent: 'amp',
      nativeId: thread.id,
      cwd: thread.env?.initialWorkingDirectory ?? thread.env?.cwd ?? treePath,
      title: deriveTitle(thread.title || firstText || truncate(thread.id, 60)),
      createdAt: created ?? stat.birthtimeMs,
      // Tool-result turns often have no timestamp, so mtime must remain part
      // of the version marker while an active transcript is still growing.
      updatedAt: Math.max(lastSent ?? 0, stat.mtimeMs),
      messageCount: msgs.length,
      sourcePath: path,
      subAgents: []
    }
  }
  const entry: LocalEntry = { mtimeMs: stat.mtimeMs, size: stat.size, meta }
  localCache.set(path, entry)
  return entry
}

export const ampCollector: Collector = {
  agent: 'amp',

  async list(home: string): Promise<ListResult> {
    const root = rootFor(home)
    let files: string[] = []
    try {
      files = (await fs.readdir(root)).filter((f) => f.endsWith('.json'))
    } catch {
      // Newer Amp versions keep canonical transcripts on the server, so the
      // absence of the legacy local directory is not an error.
    }
    const local = (
      await mapLimit(files, 8, async (file) => {
        try {
          const meta = (await readLocalThread(join(root, file)))?.meta
          // Copied: the indexer rewrites id/vaultId on the objects it receives,
          // which would corrupt the cached template on the next scan.
          return meta ? { ...meta } : null
        } catch {
          // Exports are immutable, so an unreadable one stays unreadable —
          // skipping it (rather than reporting a partial scan) is correct.
          return null
        }
      })
    ).filter((meta): meta is SessionMeta => meta != null)

    let cloud: SessionMeta[] = []
    let partial = false
    try {
      cloud = await listCloudThreads(home)
    } catch (err) {
      // Signalling a partial scan keeps the indexer from pruning every server
      // thread just because Amp was offline or the CLI could not be found.
      partial = true
      console.error('[amp] failed to list server threads:', err)
    }

    // The same thread can exist both as a legacy local file and on the server;
    // keep whichever copy was touched last.
    const byNativeId = new Map<string, SessionMeta>()
    for (const meta of [...local, ...cloud]) {
      const prev = byNativeId.get(meta.nativeId)
      if (!prev || meta.updatedAt > prev.updatedAt) byNativeId.set(meta.nativeId, meta)
    }
    return { metas: [...byNativeId.values()], partial }
  },

  async load(
    path: string,
    options?: { fresh?: boolean; allowStale?: boolean }
  ): Promise<Message[]> {
    try {
      const isCloudCache = path.startsWith(cloudCacheRootFor(HOME) + '/')
      const thread = isCloudCache
        ? await loadCloudThread(path, options)
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
