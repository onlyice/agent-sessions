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
  /** Structured tool output when the collector can preserve it. */
  toolResult?: unknown
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
  /**
   * Globally unique id. Collectors emit `${agent}:${nativeId}`; the indexer
   * prefixes it with the owning vault id => `${vaultId}:${agent}:${nativeId}`.
   */
  id: string
  /** Vault this session belongs to. Assigned by the indexer before upsert. */
  vaultId: string
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

/** A data source: a home directory the collectors resolve their paths under. */
export interface Vault {
  /** Stable id. The built-in local vault is always `'default'`. */
  id: string
  /** Display name. */
  name: string
  /** Absolute path to the home directory (contains `.claude`, `.codex`, …). */
  home: string
  /** Built-in vaults (the local Home) can't be removed. */
  removable: boolean
}

export interface VaultConfig {
  vaults: Vault[]
  activeVaultId: string
}

export interface ListResult {
  metas: SessionMeta[]
  /**
   * The scan couldn't see every session (a remote source was unreachable, the
   * CLI is missing, …). The indexer then keeps this agent's existing rows
   * instead of pruning them as "deleted from disk".
   */
  partial?: boolean
}

export interface Collector {
  agent: AgentType
  /**
   * Quick scan: return session metadata without loading full transcripts.
   * `home` is the vault's home directory the agent's data dir lives under.
   * Emitted ids are `${agent}:${nativeId}`; the indexer adds the vault prefix.
   */
  list(home: string): Promise<ListResult>
  /** Load the full transcript for one session by its source path. */
  load(sourcePath: string, options?: { fresh?: boolean; allowStale?: boolean }): Promise<Message[]>
  /** Remote sources that should fetch and index their transcript only when opened. */
  loadOnDemand?(sourcePath: string): boolean
}
