import type {
  AgentType,
  IndexProgress,
  Message,
  Role,
  SearchHit,
  SessionMeta,
  Vault,
  VaultConfig
} from './types'

interface SearchOptions {
  query: string
  roles?: Role[]
  agents?: AgentType[]
  limit?: number
}

interface GetSessionOptions {
  /** Bypass caches and re-fetch remote transcripts. */
  fresh?: boolean
  /** Fetch the session header only — `messages` comes back empty. */
  metaOnly?: boolean
  /** Hash of the transcript already held; unchanged content is not resent. */
  knownHash?: string
}

/** `messages` is empty when `unchanged` is set — keep whatever is on screen. */
interface TranscriptPayload {
  messages: Message[]
  contentHash: string
  unchanged?: boolean
}

interface Api {
  agentLabels(): Promise<Record<AgentType, string>>
  listSessions(): Promise<SessionMeta[]>
  getSession(
    id: string,
    options?: GetSessionOptions
  ): Promise<(TranscriptPayload & { meta: SessionMeta }) | null>
  loadSubAgent(sourcePath: string, knownHash?: string): Promise<TranscriptPayload>
  search(opts: SearchOptions): Promise<SearchHit[]>
  stats(): Promise<{ sessions: number; messages: number }>
  resume(id: string): Promise<{ ok: boolean; command: string; error?: string }>
  copyResumeCommand(id: string): Promise<string>
  exportTranscriptHtml(
    html: string,
    defaultPath: string
  ): Promise<{ canceled: boolean; filePath?: string }>
  reindex(): Promise<{ sessions: number; messages: number }>
  listVaults(): Promise<VaultConfig>
  /** Opens a native folder picker; returns the validated home + a suggested name, an error, or a cancel flag. */
  pickVaultDir(): Promise<{ home?: string; suggestedName?: string; error?: string; canceled?: boolean }>
  /** Add a vault at `home` under `name`; returns the updated config or an error. */
  addVault(home: string, name: string): Promise<{ config?: VaultConfig; error?: string }>
  removeVault(id: string): Promise<VaultConfig>
  renameVault(id: string, name: string): Promise<VaultConfig>
  setActiveVault(id: string): Promise<VaultConfig>
  onReindexProgress(cb: (p: IndexProgress) => void): () => void
}

export type { Vault, VaultConfig }

export const api = (window as unknown as { api: Api }).api
export type { SearchOptions }
