import { homedir } from 'os'
import { join } from 'path'
import type { Block, Role } from '../types'

export const HOME = homedir()

export function expand(p: string): string {
  if (p.startsWith('~')) return join(HOME, p.slice(1))
  return p
}

/**
 * Map over items with bounded concurrency, preserving input order. Scans are
 * IO-bound over many files, so a little parallelism helps a lot — but an
 * unbounded Promise.all over a whole thread directory holds every parsed file
 * in memory at once.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Parse a JSONL file into an array of objects, tolerating broken lines. */
export function parseJsonl(content: string): any[] {
  const out: any[] = []
  for (const line of content.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      // skip malformed line
    }
  }
  return out
}

/** Coerce anything (string | array | object) into readable text. */
export function asText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>
          return (o.text as string) ?? (o.thinking as string) ?? ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>
    return (o.text as string) ?? (o.thinking as string) ?? ''
  }
  return String(content)
}

/** Build the flattened searchable text from a list of blocks. */
export function flatten(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.kind === 'tool_use') {
        const input = b.toolInput ? truncate(stringify(b.toolInput), 4000) : ''
        return `[${b.toolName ?? 'tool'}] ${input}`
      }
      return b.text ?? ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function toMillis(ts: unknown): number | null {
  if (ts == null) return null
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** First non-empty line of text, trimmed to a title length. */
export function deriveTitle(text: string, fallback = 'Untitled session'): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return fallback
  return truncate(line.replace(/\s+/g, ' '), 80)
}

export const ROLE_FROM: Record<string, Role> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  developer: 'system',
  tool: 'tool'
}
