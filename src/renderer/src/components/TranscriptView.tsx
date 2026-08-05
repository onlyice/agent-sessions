import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bot, ChevronDown, ChevronUp, Copy, Play, Search, X } from 'lucide-react'
import { api } from '../api'
import type { Message, Role, SessionMeta, SubAgentMeta } from '../types'
import { AGENT_META, ROLE_META, fullTime, shortPath } from '../util'
import { MessageItem } from './MessageItem'

interface Props {
  sessionId: string
  /** Optional message index to scroll to (from a search hit). */
  jumpTo?: number
  /** When set, display this sub-agent's transcript instead of the main session. */
  subAgent?: SubAgentMeta
  onSelectSubAgent?: (sa: SubAgentMeta) => void
  onBackToParent?: () => void
}

interface DisplayMessage {
  key: string
  message: Message
  relatedIdxs: number[]
}

const ALL_ROLES: Role[] = ['user', 'assistant', 'thinking', 'tool', 'system']

function isToolBlock(kind: Message['blocks'][number]['kind']): boolean {
  return kind === 'tool_use' || kind === 'tool_result'
}

function toolCallId(message: Message): string | undefined {
  const id = message.blocks[0]?.toolCallId
  return typeof id === 'string' && id.trim() ? id : undefined
}

function splitToolBlocks(messages: Message[]): DisplayMessage[] {
  const out: DisplayMessage[] = []

  for (const message of messages) {
    let segment = 0
    let regularBlocks: Message['blocks'] = []

    const push = (blocks: Message['blocks']): void => {
      out.push({
        key: `${message.idx}-${segment++}`,
        message: {
          ...message,
          role: blocks.length === 1 && isToolBlock(blocks[0].kind) ? 'tool' : message.role,
          text: blocks.map((block) => block.text).filter(Boolean).join('\n'),
          blocks
        },
        relatedIdxs: [message.idx]
      })
    }

    for (const block of message.blocks) {
      if (isToolBlock(block.kind)) {
        if (regularBlocks.length > 0) {
          push(regularBlocks)
          regularBlocks = []
        }
        push([block])
      } else {
        regularBlocks.push(block)
      }
    }
    if (regularBlocks.length > 0) push(regularBlocks)
  }

  return out
}

function mergeToolMessages(messages: Message[]): DisplayMessage[] {
  const parts = splitToolBlocks(messages)
  const out: DisplayMessage[] = []
  const consumed = new Set<number>()

  function findMatchingResult(inputIndex: number): number | undefined {
    const id = toolCallId(parts[inputIndex].message)
    if (id) {
      const match = parts.findIndex(
        ({ message: candidate }, candidateIndex) =>
          candidateIndex > inputIndex &&
          !consumed.has(candidateIndex) &&
          candidate.blocks[0]?.kind === 'tool_result' &&
          toolCallId(candidate) === id
      )
      return match >= 0 ? match : undefined
    }

    const next = parts[inputIndex + 1]?.message
    return next && !consumed.has(inputIndex + 1) && next.blocks[0]?.kind === 'tool_result'
      ? inputIndex + 1
      : undefined
  }

  for (let i = 0; i < parts.length; i++) {
    const current = parts[i]
    if (consumed.has(i)) continue

    const resultIndex =
      current.message.blocks[0]?.kind === 'tool_use' ? findMatchingResult(i) : undefined
    if (resultIndex != null) {
      const result = parts[resultIndex]
      const input = current.message.blocks[0]
      const output = result.message.blocks[0]
      const durationMs =
        current.message.timestamp != null && result.message.timestamp != null
          ? result.message.timestamp - current.message.timestamp
          : undefined
      out.push({
        key: current.key,
        message: {
          ...current.message,
          role: 'tool',
          text: [current.message.text, result.message.text].filter(Boolean).join('\n'),
          blocks: [input, { ...output, toolName: output.toolName ?? input.toolName }],
          timestamp: current.message.timestamp ?? result.message.timestamp,
          toolDurationMs: durationMs != null && durationMs >= 0 ? durationMs : undefined
        },
        relatedIdxs: [...new Set([...current.relatedIdxs, ...result.relatedIdxs])]
      })
      consumed.add(resultIndex)
    } else {
      out.push(current)
    }
  }
  return out
}

export function TranscriptView({
  sessionId,
  jumpTo,
  subAgent,
  onSelectSubAgent,
  onBackToParent
}: Props): React.JSX.Element {
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [roleFilters, setRoleFilters] = useState<Set<Role>>(new Set())
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string>('')
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const matchRangesRef = useRef<Range[]>([])

  const displayMessages = useMemo(() => mergeToolMessages(messages), [messages])
  const visibleDisplayMessages = useMemo(() => {
    if (roleFilters.size === 0) return displayMessages
    return displayMessages.filter(({ message }) => roleFilters.has(message.role))
  }, [displayMessages, roleFilters])

  useEffect(() => {
    let alive = true
    setLoading(true)
    if (subAgent) {
      api.getSession(sessionId).then((sessionRes) => {
        if (!alive) return
        setMeta(sessionRes?.meta ?? null)
      })
      api.loadSubAgent(subAgent.sourcePath).then((res) => {
        if (!alive) return
        setMessages(res?.messages ?? [])
        setLoading(false)
      })
    } else {
      api.getSession(sessionId).then((res) => {
        if (!alive) return
        setMeta(res?.meta ?? null)
        setMessages(res?.messages ?? [])
        setLoading(false)
      })
    }
    return () => {
      alive = false
    }
  }, [sessionId, subAgent])

  useEffect(() => {
    if (loading || jumpTo == null) return
    const el = scrollRef.current?.querySelector(`[data-idx~="${jumpTo}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('flash')
    const t = setTimeout(() => el?.classList.remove('flash'), 1600)
    return () => clearTimeout(t)
  }, [loading, jumpTo, visibleDisplayMessages])

  // Cmd+F to open search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Debounce the search query to avoid expensive DOM walks on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Walk the DOM and build highlight ranges via CSS Custom Highlight API
  useEffect(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('transcript-search')
    CSS.highlights.delete('transcript-search-current')
    matchRangesRef.current = []

    if (!debouncedQuery.trim() || !scrollRef.current) {
      setTotalMatches(0)
      return
    }

    const q = debouncedQuery.toLowerCase()
    const ranges: Range[] = []
    const walker = document.createTreeWalker(scrollRef.current, NodeFilter.SHOW_TEXT)

    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const text = node.textContent?.toLowerCase() ?? ''
      let start = 0
      for (;;) {
        const idx = text.indexOf(q, start)
        if (idx === -1) break
        const range = new Range()
        range.setStart(node, idx)
        range.setEnd(node, idx + q.length)
        ranges.push(range)
        start = idx + q.length
      }
    }

    matchRangesRef.current = ranges
    setTotalMatches(ranges.length)
    setCurrentMatch((prev) => (ranges.length > 0 ? Math.min(prev, ranges.length - 1) : 0))

    // Cap highlighted ranges to avoid browser paint stalls on short queries
    const MAX_HIGHLIGHTS = 500
    if (ranges.length > 0) {
      const toHighlight = ranges.length <= MAX_HIGHLIGHTS ? ranges : ranges.slice(0, MAX_HIGHLIGHTS)
      CSS.highlights.set('transcript-search', new Highlight(...toHighlight))
    }
  }, [debouncedQuery, visibleDisplayMessages])

  // Highlight + scroll to the current match
  useEffect(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('transcript-search-current')

    const ranges = matchRangesRef.current
    if (ranges.length === 0 || currentMatch >= ranges.length) return

    const range = ranges[currentMatch]
    CSS.highlights.set('transcript-search-current', new Highlight(range))

    const el = range.startContainer.parentElement
    if (!el || !scrollRef.current) return
    const cr = scrollRef.current.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    if (er.top < cr.top || er.bottom > cr.bottom) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentMatch, totalMatches])

  // Clean up highlights on unmount
  useEffect(() => {
    return () => {
      CSS.highlights?.delete('transcript-search')
      CSS.highlights?.delete('transcript-search-current')
    }
  }, [])

  const closeSearch = useCallback((): void => {
    setShowSearch(false)
    setSearchQuery('')
    setDebouncedQuery('')
  }, [])

  const goToMatch = useCallback(
    (delta: number): void => {
      setCurrentMatch((prev) => {
        if (totalMatches === 0) return 0
        return (prev + delta + totalMatches) % totalMatches
      })
    },
    [totalMatches]
  )

  async function onResume(): Promise<void> {
    const res = await api.resume(sessionId)
    if (res.ok) {
      setToast('Opened a new Ghostty tab ✓')
    } else {
      await api.copyResumeCommand(sessionId)
      setToast(`Could not control Ghostty (${res.error ?? 'error'}). Command copied to clipboard.`)
    }
    setTimeout(() => setToast(''), 5000)
  }

  async function copyProjectPath(path: string): Promise<void> {
    await navigator.clipboard.writeText(path)
    setToast('Project path copied')
    setTimeout(() => setToast(''), 2500)
  }

  function toggleRole(role: Role): void {
    setRoleFilters((current) => {
      const next = new Set(current)
      next.has(role) ? next.delete(role) : next.add(role)
      return next
    })
  }

  if (loading) return <div className="transcript empty">Loading…</div>
  if (!meta) return <div className="transcript empty">Session not found</div>

  const agent = AGENT_META[meta.agent]
  const hasSubs = meta.subAgents.length > 0

  return (
    <div className="transcript">
      <header className="transcript-head">
        {subAgent && (
          <div className="th-back">
            <button className="btn btn-back" onClick={onBackToParent}>
              <ArrowLeft size={14} /> Back to main session
            </button>
            <span className="th-sub-label" title={subAgent.label}>
              <Bot size={13} /> {subAgent.label}
            </span>
          </div>
        )}
        <div className="th-main">
          <span className="agent-badge" style={{ background: agent.color }}>
            {agent.label}
          </span>
          <h2 title={subAgent ? subAgent.label : meta.title}>
            {subAgent ? subAgent.label : meta.title}
          </h2>
        </div>
        <div className="th-sub">
          <span className="th-path" title={meta.cwd}>
            {shortPath(meta.cwd) || '—'}
          </span>
          {meta.cwd && (
            <button
              className="path-copy"
              onClick={() => void copyProjectPath(meta.cwd)}
              title="Copy project path"
              aria-label="Copy project path"
            >
              <Copy size={12} />
            </button>
          )}
          <span className="th-dot">·</span>
          <span>{subAgent ? subAgent.messageCount : meta.messageCount} msgs</span>
          <span className="th-dot">·</span>
          <span>{fullTime(meta.updatedAt)}</span>
        </div>
        {!subAgent && (
          <div className="th-actions">
            <button className="btn primary" onClick={onResume}>
              <Play size={14} /> Resume in Ghostty
            </button>
            <button
              className="btn"
              onClick={async () => {
                await api.copyResumeCommand(sessionId)
                setToast('Resume command copied')
                setTimeout(() => setToast(''), 2500)
              }}
            >
              Copy command
            </button>
          </div>
        )}
        {hasSubs && (
          <div className="th-subagents">
            <span className="filter-label message-filter-label">
              <Bot size={13} /> Sub-agents
            </span>
            {meta.subAgents.map((sa) => (
              <button
                key={sa.id}
                className={`chip sub-agent-chip ${subAgent?.id === sa.id ? 'on' : ''}`}
                onClick={() => onSelectSubAgent?.(sa)}
                title={sa.label}
              >
                {sa.label.length > 40 ? sa.label.slice(0, 40) + '…' : sa.label}
                <span className="sa-chip-count">{sa.messageCount}</span>
              </button>
            ))}
          </div>
        )}
        <div className="message-type-filter">
          <span className="filter-label message-filter-label">Messages</span>
          <button
            className={`chip ${roleFilters.size === 0 ? 'on' : ''}`}
            onClick={() => setRoleFilters(new Set())}
            aria-pressed={roleFilters.size === 0}
          >
            All
          </button>
          {ALL_ROLES.map((role) => (
            <button
              key={role}
              className={`chip ${roleFilters.has(role) ? 'on' : ''}`}
              style={
                roleFilters.has(role)
                  ? { borderColor: ROLE_META[role].color, color: ROLE_META[role].color }
                  : undefined
              }
              onClick={() => toggleRole(role)}
              aria-pressed={roleFilters.has(role)}
            >
              {ROLE_META[role].label}
            </button>
          ))}
          <span className="message-filter-count">
            {visibleDisplayMessages.length}/{displayMessages.length}
          </span>
        </div>
      </header>

      {showSearch && (
        <div className="transcript-search-bar">
          <Search size={14} className="ts-icon" />
          <input
            ref={searchInputRef}
            className="ts-input"
            placeholder="Search in transcript…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setCurrentMatch(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                goToMatch(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') closeSearch()
            }}
            autoFocus
          />
          {searchQuery && (
            <span className="ts-count">
              {totalMatches > 0 ? `${currentMatch + 1}/${totalMatches}` : 'No matches'}
            </span>
          )}
          <button
            className="ts-nav"
            onClick={() => goToMatch(-1)}
            disabled={totalMatches === 0}
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="ts-nav"
            onClick={() => goToMatch(1)}
            disabled={totalMatches === 0}
            title="Next match (Enter)"
          >
            <ChevronDown size={15} />
          </button>
          <button className="ts-nav" onClick={closeSearch} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
      )}

      <div className="transcript-scroll" ref={scrollRef}>
        {visibleDisplayMessages.map(({ key, message, relatedIdxs }) => (
          <div key={key} data-idx={relatedIdxs.join(' ')}>
            <MessageItem message={message} />
          </div>
        ))}
        {messages.length === 0 && <div className="empty">No renderable messages</div>}
        {messages.length > 0 && visibleDisplayMessages.length === 0 && (
          <div className="empty">No messages match this filter</div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
