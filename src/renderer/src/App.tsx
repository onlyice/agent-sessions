import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, Folder, RefreshCw, Settings as SettingsIcon, X } from 'lucide-react'
import { api } from './api'
import type {
  AgentType,
  IndexProgress,
  Role,
  SearchHit,
  SessionMeta,
  SubAgentMeta,
  Vault
} from './types'
import { AGENT_META, ROLE_META, baseName, relTime, shortPath } from './util'
import { TranscriptView } from './components/TranscriptView'
import { Settings } from './components/Settings'
import { useSettings } from './settings'

const ALL_ROLES: Role[] = ['user', 'assistant', 'thinking', 'tool', 'system']
const ALL_AGENTS: AgentType[] = ['claude', 'codex', 'opencode', 'amp', 'pi']

interface Selection {
  sessionId: string
  jumpTo?: number
  /** When set, view a sub-agent transcript instead of the main session. */
  subAgent?: SubAgentMeta
}

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [query, setQuery] = useState('')
  const [roles, setRoles] = useState<Set<Role>>(new Set())
  const [agents, setAgents] = useState<Set<AgentType>>(new Set())
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [searching, setSearching] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [vaults, setVaults] = useState<Vault[]>([])
  const [activeVaultId, setActiveVaultId] = useState('default')
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false)
  const [settings, setSettings] = useSettings()
  // Sidebar width is stored as a fraction of the window so it scales
  // proportionally when the window itself is resized.
  const [sidebarFrac, setSidebarFrac] = useState<number>(() => {
    const v = Number(localStorage.getItem('sidebar.frac'))
    return v > 0.08 && v < 0.7 ? v : 0.26
  })
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reindexTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reindexing = useRef(false)
  const reindexIntervalMinutes = useRef(settings.reindexIntervalMinutes)

  const clearReindexTimer = useCallback((): void => {
    clearTimeout(reindexTimer.current)
    reindexTimer.current = undefined
  }, [])

  const runReindex = useCallback(async (): Promise<void> => {
    if (reindexing.current) return
    reindexing.current = true
    try {
      await api.reindex()
    } finally {
      reindexing.current = false
    }
  }, [])

  const scheduleReindex = useCallback((): void => {
    clearReindexTimer()
    const minutes = Math.min(Math.max(Number(reindexIntervalMinutes.current) || 5, 1), 1440)
    reindexTimer.current = setTimeout(() => {
      void runReindex()
    }, minutes * 60 * 1000)
  }, [clearReindexTimer, runReindex])

  useEffect(() => {
    reindexIntervalMinutes.current = settings.reindexIntervalMinutes
    scheduleReindex()
  }, [scheduleReindex, settings.reindexIntervalMinutes])

  useEffect(() => clearReindexTimer, [clearReindexTimer])

  useEffect(() => {
    localStorage.setItem('sidebar.frac', String(sidebarFrac))
  }, [sidebarFrac])

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => {
      const px = Math.min(Math.max(ev.clientX, 240), Math.min(680, window.innerWidth * 0.6))
      setSidebarFrac(px / window.innerWidth)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const refresh = useCallback(async (): Promise<void> => {
    const list = await api.listSessions()
    setSessions(list)
  }, [])

  const loadVaults = useCallback(async (): Promise<void> => {
    const cfg = await api.listVaults()
    setVaults(cfg.vaults)
    setActiveVaultId(cfg.activeVaultId)
  }, [])

  const switchVault = useCallback(
    async (id: string): Promise<void> => {
      setVaultMenuOpen(false)
      if (id === activeVaultId) return
      const cfg = await api.setActiveVault(id)
      setActiveVaultId(cfg.activeVaultId)
      // A vault switch changes the whole result set: drop the current view.
      setSelection(null)
      setQuery('')
      setHits(null)
      await refresh()
    },
    [activeVaultId, refresh]
  )

  const addVault = useCallback(async (): Promise<string | null> => {
    const res = await api.addVault()
    if (res.canceled) return null
    if (res.error) return res.error
    if (res.config) {
      setVaults(res.config.vaults)
      setActiveVaultId(res.config.activeVaultId)
    }
    return null
  }, [])

  const removeVault = useCallback(
    async (id: string): Promise<void> => {
      const cfg = await api.removeVault(id)
      setVaults(cfg.vaults)
      setActiveVaultId(cfg.activeVaultId)
      // The removed vault's sessions are gone; if it was active, reload the list.
      setSelection(null)
      setHits(null)
      setQuery('')
      await refresh()
    },
    [refresh]
  )

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])

  useEffect(() => {
    refresh()
    const off = api.onReindexProgress((p) => {
      setProgress(p)
      if (p.phase === 'done') {
        reindexing.current = false
        refresh()
        scheduleReindex()
        setTimeout(() => setProgress(null), 1500)
      } else {
        reindexing.current = true
      }
    })
    return off
  }, [scheduleReindex, refresh])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Debounced search whenever query/filters change.
  useEffect(() => {
    clearTimeout(debounce.current)
    if (!query.trim()) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    debounce.current = setTimeout(async () => {
      const res = await api.search({
        query,
        roles: roles.size ? [...roles] : undefined,
        agents: agents.size ? [...agents] : undefined,
        limit: 300
      })
      setHits(res)
      setSearching(false)
    }, 180)
    return () => clearTimeout(debounce.current)
  }, [query, roles, agents])

  // Apply agent filter to the plain session list too.
  const visibleSessions = useMemo(
    () => (agents.size ? sessions.filter((s) => agents.has(s.agent)) : sessions),
    [sessions, agents]
  )

  // Group search hits by session, preserving rank order.
  const groupedHits = useMemo(() => {
    if (!hits) return []
    const map = new Map<string, { meta: SearchHit; hits: SearchHit[] }>()
    for (const h of hits) {
      let g = map.get(h.sessionId)
      if (!g) {
        g = { meta: h, hits: [] }
        map.set(h.sessionId, g)
      }
      g.hits.push(h)
    }
    return [...map.values()]
  }, [hits])

  function toggle<T>(set: Set<T>, val: T, setter: (s: Set<T>) => void): void {
    const next = new Set(set)
    next.has(val) ? next.delete(val) : next.add(val)
    setter(next)
  }

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: `${(sidebarFrac * 100).toFixed(3)}%` }}>
        <VaultSwitcher
          vaults={vaults}
          activeVaultId={activeVaultId}
          open={vaultMenuOpen}
          onToggle={() => setVaultMenuOpen((v) => !v)}
          onClose={() => setVaultMenuOpen(false)}
          onPick={switchVault}
          onManage={() => {
            setVaultMenuOpen(false)
            setShowSettings(true)
          }}
        />
        <div className="search-area">
          <div className="search-row">
            <input
              className="search-input"
              placeholder="Search all transcripts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {query && (
              <button className="clear-btn" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </div>

          <div className="filters">
            <span className="filter-label">Scope</span>
            {ALL_ROLES.map((r) => (
              <button
                key={r}
                className={`chip ${roles.has(r) ? 'on' : ''}`}
                style={roles.has(r) ? { borderColor: ROLE_META[r].color, color: ROLE_META[r].color } : undefined}
                onClick={() => toggle(roles, r, setRoles)}
              >
                {ROLE_META[r].label}
              </button>
            ))}
          </div>
          <div className="filters">
            <span className="filter-label">Agent</span>
            {ALL_AGENTS.map((a) => (
              <button
                key={a}
                className={`chip ${agents.has(a) ? 'on' : ''}`}
                style={agents.has(a) ? { borderColor: AGENT_META[a].color, color: AGENT_META[a].color } : undefined}
                onClick={() => toggle(agents, a, setAgents)}
              >
                {AGENT_META[a].short}
              </button>
            ))}
          </div>
        </div>

        <div className="list">
          {hits !== null ? (
            <SearchResults
              groups={groupedHits}
              searching={searching}
              selection={selection}
              onPick={(sessionId, jumpTo) => setSelection({ sessionId, jumpTo })}
            />
          ) : (
            <SessionList
              sessions={visibleSessions}
              selection={selection}
              onPick={(id) => setSelection({ sessionId: id })}
              onPickSubAgent={(sessionId, sa) => setSelection({ sessionId, subAgent: sa })}
            />
          )}
        </div>

        <footer className="side-foot">
          {progress && progress.phase !== 'done' ? (
            <span>
              Indexing… {progress.indexed}/{progress.total}
            </span>
          ) : (
            <span>{visibleSessions.length} sessions</span>
          )}
          <div className="foot-actions">
            <button className="refresh" onClick={() => setShowSettings(true)} title="Settings">
              <SettingsIcon size={16} />
            </button>
            <button className="refresh" onClick={() => void runReindex()} title="Re-scan disk">
              <RefreshCw size={15} />
            </button>
          </div>
        </footer>
      </aside>

      <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

      <main className="main">
        {selection ? (
          <TranscriptView
            sessionId={selection.sessionId}
            jumpTo={selection.jumpTo}
            subAgent={selection.subAgent}
            onSelectSubAgent={(sa) =>
              setSelection({ sessionId: selection.sessionId, subAgent: sa })
            }
            onBackToParent={() =>
              setSelection({ sessionId: selection.sessionId })
            }
          />
        ) : (
          <div className="welcome">
            <h1>Agent Sessions</h1>
            <p>
              Browsing transcripts from Claude Code, Codex, OpenCode, Amp and Pi. Select a session
              on the left, or search across everything.
            </p>
          </div>
        )}
      </main>

      {showSettings && (
        <Settings
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          vaults={vaults}
          activeVaultId={activeVaultId}
          onAddVault={addVault}
          onRemoveVault={removeVault}
          onSwitchVault={switchVault}
        />
      )}
    </div>
  )
}

interface PathTip {
  top: number
  left: number
  text: string
}

function SessionList({
  sessions,
  selection,
  onPick,
  onPickSubAgent
}: {
  sessions: SessionMeta[]
  selection: Selection | null
  onPick: (id: string) => void
  onPickSubAgent: (sessionId: string, sa: SubAgentMeta) => void
}): React.JSX.Element {
  const [tip, setTip] = useState<PathTip | null>(null)

  if (sessions.length === 0) return <div className="empty pad">No sessions indexed yet.</div>
  return (
    <>
      {sessions.map((s) => {
        const agent = AGENT_META[s.agent]
        const pathText = shortPath(s.cwd) || '—'
        const isSelected = selection?.sessionId === s.id
        const hasSubs = s.subAgents.length > 0
        return (
          <div key={s.id} className="session-group">
            <button
              className={`session-card ${isSelected && !selection?.subAgent ? 'active' : ''}`}
              onClick={() => onPick(s.id)}
            >
              <div className="sc-top">
                <span className="sc-dot" style={{ background: agent.color }} />
                <span className="sc-title">{s.title}</span>
              </div>
              <div className="sc-meta">
                <span className="sc-agent">{agent.label}</span>
                <span className="th-dot">·</span>
                <span className="sc-folder">
                  <Folder size={12} className="sc-folder-icon" />
                  {baseName(s.cwd) || '—'}
                </span>
                <span className="sc-stats">
                  {relTime(s.updatedAt)} · {s.messageCount} msgs
                </span>
              </div>
              {hasSubs && (
                <div className="sc-meta dim sc-sub-count">
                  <Bot size={12} />
                  <span>{s.subAgents.length} sub-agent{s.subAgents.length > 1 ? 's' : ''}</span>
                </div>
              )}
              <div
                className="sc-meta dim sc-full-path"
                onMouseEnter={(e) => {
                  const el = e.currentTarget
                  if (el.scrollWidth <= el.clientWidth + 1) return
                  const r = el.getBoundingClientRect()
                  setTip({ top: r.top, left: r.left, text: pathText })
                }}
                onMouseLeave={() => setTip(null)}
              >
                {pathText}
              </div>
            </button>
            {isSelected && hasSubs && (
              <div className="sub-agent-list">
                {s.subAgents.map((sa) => (
                  <button
                    key={sa.id}
                    className={`sub-agent-item ${selection?.subAgent?.id === sa.id ? 'active' : ''}`}
                    onClick={() => onPickSubAgent(s.id, sa)}
                    title={sa.label}
                  >
                    <Bot size={11} className="sa-icon" />
                    <span className="sa-label">{sa.label}</span>
                    <span className="sa-count">{sa.messageCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {tip && (
        <div className="path-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.text}
        </div>
      )}
    </>
  )
}

function SearchResults({
  groups,
  searching,
  selection,
  onPick
}: {
  groups: { meta: SearchHit; hits: SearchHit[] }[]
  searching: boolean
  selection: Selection | null
  onPick: (sessionId: string, jumpTo: number) => void
}): React.JSX.Element {
  if (searching && groups.length === 0) return <div className="empty pad">Searching…</div>
  if (groups.length === 0) return <div className="empty pad">No matches.</div>
  return (
    <>
      <div className="result-count">
        {groups.reduce((n, g) => n + g.hits.length, 0)} matches in {groups.length} sessions
      </div>
      {groups.map((g) => {
        const agent = AGENT_META[g.meta.agent]
        return (
          <div key={g.meta.sessionId} className="result-group">
            <div className="rg-head">
              <span className="sc-dot" style={{ background: agent.color }} />
              <span className="rg-title">{g.meta.title}</span>
              <span className="rg-agent">{agent.short}</span>
            </div>
            {g.hits.map((h) => (
              <button
                key={h.idx}
                className={`hit ${
                  selection?.sessionId === h.sessionId && selection?.jumpTo === h.idx ? 'active' : ''
                }`}
                onClick={() => onPick(h.sessionId, h.idx)}
              >
                <span className="hit-role" style={{ color: ROLE_META[h.role].color }}>
                  {ROLE_META[h.role].label}
                </span>
                <span className="hit-snip" dangerouslySetInnerHTML={{ __html: renderSnippet(h.snippet) }} />
              </button>
            ))}
          </div>
        )
      })}
    </>
  )
}

function VaultSwitcher({
  vaults,
  activeVaultId,
  open,
  onToggle,
  onClose,
  onPick,
  onManage
}: {
  vaults: Vault[]
  activeVaultId: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  onPick: (id: string) => void
  onManage: () => void
}): React.JSX.Element {
  const active = vaults.find((v) => v.id === activeVaultId)
  return (
    <div className="vault-switcher">
      <button className="vault-btn" onClick={onToggle} title={active?.home}>
        <Folder size={15} className="vault-btn-icon" />
        <span className="vault-btn-name">{active?.name ?? 'Home'}</span>
        <ChevronDown size={16} className={`vault-btn-chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <>
          <div className="vault-menu-backdrop" onClick={onClose} />
          <div className="vault-menu">
            {vaults.map((v) => (
              <button key={v.id} className="vault-menu-item" onClick={() => onPick(v.id)} title={v.home}>
                <span className="vmi-check">{v.id === activeVaultId && <Check size={15} />}</span>
                <span className="vmi-body">
                  <span className="vmi-name">{v.name}</span>
                  <span className="vmi-path">{v.home}</span>
                </span>
              </button>
            ))}
            <div className="vault-menu-sep" />
            <button className="vault-menu-item manage" onClick={onManage}>
              <span className="vmi-check" />
              <span className="vmi-name">Manage vaults…</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Escape HTML then turn the «»-delimited FTS marks into <mark>. */
function renderSnippet(s: string): string {
  const esc = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return esc.replace(/«/g, '<mark>').replace(/»/g, '</mark>')
}
