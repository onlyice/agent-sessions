import type { AgentType, Message, Role } from './types'

export const AGENT_META: Record<AgentType, { label: string; color: string; short: string }> = {
  claude: { label: 'Claude Code', color: '#d97757', short: 'CC' },
  codex: { label: 'Codex CLI', color: '#10a37f', short: 'CX' },
  opencode: { label: 'OpenCode', color: '#7c8cff', short: 'OC' },
  amp: { label: 'Amp', color: '#e0b341', short: 'AM' },
  pi: { label: 'Pi', color: '#c75fd9', short: 'PI' }
}

export const ROLE_META: Record<Role, { label: string; color: string }> = {
  user: { label: 'User', color: '#4a9eff' },
  assistant: { label: 'Assistant', color: '#52c41a' },
  thinking: { label: 'Thinking', color: '#b37feb' },
  tool: { label: 'Tool', color: '#faad14' },
  system: { label: 'System', color: '#8c8c8c' }
}

/**
 * Display label + color for a message header.
 *
 * Agents like Claude Code, Pi and Amp embed tool calls inside an assistant
 * message and their results inside a user message — so a tool-only turn would
 * otherwise be mislabeled as "Assistant" / "User". When a message consists
 * purely of tool I/O, label it accordingly instead.
 */
export function messageLabel(m: Message): { label: string; color: string } {
  const kinds = new Set(m.blocks.map((b) => b.kind))
  if (kinds.size === 1) {
    if (kinds.has('tool_use')) return { label: 'Tool Input', color: ROLE_META.tool.color }
    if (kinds.has('tool_result')) return { label: 'Tool Output', color: ROLE_META.tool.color }
  }
  return ROLE_META[m.role]
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ms).toLocaleDateString()
}

export function fullTime(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function baseName(path: string): string {
  if (!path) return ''
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function shortPath(path: string): string {
  if (!path) return ''
  const home = path.match(/^\/Users\/[^/]+/)
  return home ? '~' + path.slice(home[0].length) : path
}
