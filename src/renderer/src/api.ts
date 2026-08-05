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
