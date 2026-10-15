import type { AgentType, Collector } from '../types'
import { claudeCollector } from './claude'
import { codexCollector } from './codex'
import { opencodeCollector } from './opencode'
import { piCollector } from './pi'

export const collectors: Record<AgentType, Collector> = {
  claude: claudeCollector,
  codex: codexCollector,
  opencode: opencodeCollector,
  pi: piCollector
}

/**
 * Bump this whenever a collector changes metadata or transcript parsing.
 * Scans are cached against a file's (mtime, size) alone, so an
 * unchanged file would otherwise keep serving metadata from the old parser
 * forever — a parser fix would only reach files the user happened to touch.
 */
export const SCAN_PARSER_VERSION = 3

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  pi: 'Pi'
}
