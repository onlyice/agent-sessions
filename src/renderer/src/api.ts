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

interface Api {
  agentLabels(): Promise<Record<AgentType, string>>
  listSessions(): Promise<SessionMeta[]>
  getSession(id: string): Promise<{ meta: SessionMeta; messages: Message[] } | null>
  loadSubAgent(sourcePath: string): Promise<{ messages: Message[] }>
  search(opts: SearchOptions): Promise<SearchHit[]>
  stats(): Promise<{ sessions: number; messages: number }>
  resume(id: string): Promise<{ ok: boolean; command: string; error?: string }>
  copyResumeCommand(id: string): Promise<string>
  reindex(): Promise<{ sessions: number; messages: number }>
  listVaults(): Promise<VaultConfig>
  /** Opens a native folder picker; returns the updated config, an error, or a cancel flag. */
  addVault(): Promise<{ config?: VaultConfig; error?: string; canceled?: boolean }>
  removeVault(id: string): Promise<VaultConfig>
  setActiveVault(id: string): Promise<VaultConfig>
  onReindexProgress(cb: (p: IndexProgress) => void): () => void
}

export type { Vault, VaultConfig }

export const api = (window as unknown as { api: Api }).api
export type { SearchOptions }
