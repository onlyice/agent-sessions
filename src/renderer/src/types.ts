export type AgentType = 'claude' | 'codex' | 'opencode' | 'amp' | 'pi'
export type Role = 'user' | 'assistant' | 'thinking' | 'tool' | 'system'

export interface Block {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'file'
  text?: string
  toolName?: string
  toolCallId?: string
  toolInput?: unknown
  exitCode?: number
  isError?: boolean
}

export interface Message {
  idx: number
  role: Role
  text: string
  blocks: Block[]
  timestamp: number | null
  model?: string
  /** For merged tool messages: elapsed time between the call and its result, in ms. */
  toolDurationMs?: number
}

export interface SubAgentMeta {
  id: string
  label: string
  sourcePath: string
  messageCount: number
}

export interface SessionMeta {
  id: string
  agent: AgentType
  nativeId: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  sourcePath: string
  subAgents: SubAgentMeta[]
}

export interface SearchHit {
  sessionId: string
  agent: AgentType
  title: string
  cwd: string
  idx: number
  role: Role
  timestamp: number | null
  snippet: string
  updatedAt: number
}

export interface IndexProgress {
  phase: 'scanning' | 'indexing' | 'done'
  agent?: AgentType
  indexed: number
  total: number
}
