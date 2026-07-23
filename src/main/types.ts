// Normalized data model shared across all agent collectors.

export type AgentType = 'claude' | 'codex' | 'opencode' | 'amp' | 'pi'

export type Role = 'user' | 'assistant' | 'thinking' | 'tool' | 'system'

/** A single rich content block inside a message, used for UI rendering. */
export interface Block {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'file'
  /** Human-readable text (also what gets indexed for search). */
  text?: string
  /** Tool name for tool_use / tool_result blocks. */
  toolName?: string
  /** Native call id used to associate tool_use and tool_result blocks. */
  toolCallId?: string
  /** Raw tool input (object) for tool_use blocks. */
  toolInput?: unknown
  /** Process exit code when known for command-like tool results. */
  exitCode?: number
  /** Whether a tool_result represents an error. */
  isError?: boolean
}

export interface Message {
  /** Stable per-session ordering index. */
  idx: number
  role: Role
  /** Flattened searchable plain text for the whole message. */
  text: string
  blocks: Block[]
  timestamp: number | null
  /** Model id when known (assistant messages). */
  model?: string
  /** For merged tool messages: elapsed time between the call and its result, in ms. */
  toolDurationMs?: number
}

export interface SubAgentMeta {
  /** Agent identifier, e.g. "a0a382c8448dd22a9". */
  id: string
  /** Short label derived from the first user message. */
  label: string
  /** Absolute path to the sub-agent JSONL file. */
  sourcePath: string
  messageCount: number
}

export interface SessionMeta {
  /** Globally unique id: `${agent}:${nativeId}`. */
  id: string
  agent: AgentType
  /** Native session/thread id used by the agent's resume command. */
  nativeId: string
  /** Working directory the session ran in (used for resume + grouping). */
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Absolute path to the source file/dir on disk. */
  sourcePath: string
  /** Sub-agent transcripts discovered under this session. */
  subAgents: SubAgentMeta[]
}

export interface Session extends SessionMeta {
  messages: Message[]
}

export interface Collector {
  agent: AgentType
  /** Quick scan: return session metadata without loading full transcripts. */
  list(): Promise<SessionMeta[]>
  /** Load the full transcript for one session by its source path. */
  load(sourcePath: string): Promise<Message[]>
}
