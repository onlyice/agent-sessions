import type { AgentType, Collector } from '../types'
import { claudeCollector } from './claude'
import { codexCollector } from './codex'
import { opencodeCollector } from './opencode'
import { ampCollector } from './amp'
import { piCollector } from './pi'

export const collectors: Record<AgentType, Collector> = {
  claude: claudeCollector,
  codex: codexCollector,
  opencode: opencodeCollector,
  amp: ampCollector,
  pi: piCollector
}

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  amp: 'Amp',
  pi: 'Pi'
}
