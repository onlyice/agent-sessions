import type {
  AgentType,
  IndexProgress,
  Message,
  Role,
  SearchHit,
  SessionMeta
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
  search(opts: SearchOptions): Promise<SearchHit[]>
  stats(): Promise<{ sessions: number; messages: number }>
  resume(id: string): Promise<{ ok: boolean; command: string; error?: string }>
  copyResumeCommand(id: string): Promise<string>
  reindex(): Promise<{ sessions: number; messages: number }>
  onReindexProgress(cb: (p: IndexProgress) => void): () => void
}

export const api = (window as unknown as { api: Api }).api
export type { SearchOptions }
