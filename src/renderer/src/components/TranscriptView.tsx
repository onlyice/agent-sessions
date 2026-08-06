import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, Bot, ChevronDown, ChevronUp, Copy, Download, Play, Search, X } from 'lucide-react'
import { api } from '../api'
import { CollapseContext, NO_FORCED_IDS, sameIds } from '../collapseContext'
import { buildTranscriptHtml } from '../exportTranscript'
import type { Message, Role, SessionMeta, SubAgentMeta } from '../types'
import { AGENT_META, ROLE_META, fullTime, shortPath } from '../util'
import { MessageItem } from './MessageItem'

interface Props {
  sessionId: string
  /** Optional message index to scroll to (from a search hit). */
  jumpTo?: number
  /** The search query that produced jumpTo, used to scroll to the matched text. */
  jumpQuery?: string
  /** Monotonic counter: a new value re-runs the jump even for an unchanged target. */
  jumpNonce?: number
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

interface ExportSubAgent {
  meta: SubAgentMeta
  messages: Message[]
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
      const standaloneRole =
        blocks.length === 1
          ? blocks[0].kind === 'thinking'
            ? 'thinking'
            : isToolBlock(blocks[0].kind)
              ? 'tool'
              : message.role
          : message.role
      out.push({
        key: `${message.idx}-${segment++}`,
        message: {
          ...message,
          role: standaloneRole,
          text: blocks.map((block) => block.text).filter(Boolean).join('\n'),
          blocks
        },
        relatedIdxs: [message.idx]
      })
    }

    for (const block of message.blocks) {
      if (isToolBlock(block.kind) || block.kind === 'thinking') {
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

/** Cap highlighted ranges to avoid browser paint stalls on short queries. */
const MAX_HIGHLIGHTS = 500

interface CollectOptions {
  /**
   * 'phrase' matches the query literally — what Cmd+F users expect.
   * 'terms' matches each whitespace-separated word on its own, mirroring the
   * sidebar index (see Db.search / searchLike), which ANDs one clause per term
   * and so returns hits where the words never appear next to each other.
   */
  mode: 'phrase' | 'terms'
  /** Skip messages the role filter has hidden. */
  skipHidden: boolean
}

/**
 * Find the text ranges inside scope that match query, in document order.
 * Shared by the in-transcript search and the sidebar-hit jump so both highlight
 * (and skip) the same content.
 */
function collectMatchRanges(scope: HTMLElement, query: string, options: CollectOptions): Range[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const needles =
    options.mode === 'terms' ? [...new Set(trimmed.split(/\s+/).filter(Boolean))] : [trimmed]
  const ranges: Range[] = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (options.skipHidden && node.parentElement?.closest('[data-message-role][hidden]')) continue
    if (node.parentElement?.closest('.msg-toolbar, .collapse-toggle')) continue
    const message = node.parentElement?.closest('.msg')
    if (node.parentElement?.closest('.text-view-source') && !message?.classList.contains('source-view')) continue
    if (node.parentElement?.closest('.text-view-markdown') && message?.classList.contains('source-view')) continue
    const text = node.textContent?.toLowerCase() ?? ''
    const hits: Array<[number, number]> = []
    for (const needle of needles) {
      let start = 0
      for (;;) {
        const idx = text.indexOf(needle, start)
        if (idx === -1) break
        hits.push([idx, idx + needle.length])
        start = idx + needle.length
      }
    }
    // The walker is already in document order, but several terms can match
    // inside one text node in any order — sort so next/prev never steps
    // backwards, longest first at a shared start so the outer match wins.
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    let lastEnd = 0
    for (const [from, to] of hits) {
      // Drop matches swallowed by an earlier one (nested or overlapping terms,
      // e.g. "test testing"), so the count and the navigation stops are honest.
      if (from < lastEnd) continue
      const range = new Range()
      range.setStart(node, from)
      range.setEnd(node, to)
      ranges.push(range)
      lastEnd = to
    }
  }
  return ranges
}

/** Ids of the Collapsible blocks containing these ranges, for forcing them open. */
function collapsibleIdsFor(ranges: Range[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const range of ranges) {
    const id = range.startContainer.parentElement?.closest<HTMLElement>('[data-collapsible-id]')
      ?.dataset.collapsibleId
    if (id) ids.add(id)
  }
  return ids.size === 0 ? NO_FORCED_IDS : ids
}

function ExportSubAgentSection({ meta, messages }: ExportSubAgent): React.JSX.Element {
  const displayMessages = mergeToolMessages(messages)
  return (
    <section data-export-session={meta.id} hidden>
      {displayMessages.map(({ key, message, relatedIdxs }) => (
        <div key={key} data-idx={relatedIdxs.join(' ')} data-message-role={message.role}>
          <MessageItem message={message} />
        </div>
      ))}
      {messages.length === 0 && <div className="empty">No renderable messages</div>}
    </section>
  )
}

export function TranscriptView({
  sessionId,
  jumpTo,
  jumpQuery,
  jumpNonce,
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
  const [viewRevision, setViewRevision] = useState(0)
  const [exportSubAgents, setExportSubAgents] = useState<ExportSubAgent[]>([])
  // Collapsible blocks forced open because they hold a match. Kept as two sets
  // so the in-transcript search and a sidebar jump cannot clobber each other.
  const [searchExpandIds, setSearchExpandIds] = useState<ReadonlySet<string>>(NO_FORCED_IDS)
  const [jumpExpandIds, setJumpExpandIds] = useState<ReadonlySet<string>>(NO_FORCED_IDS)
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const matchRangesRef = useRef<Range[]>([])
  const scrollAnimRef = useRef(0)

  /**
   * Scroll a match into view with a short, cancellable animation. Accepts a
   * Range so positioning uses the matched text's exact rect — the parent
   * element of a long text node (e.g. a whole .tool-body <pre> content) spans
   * far beyond the match itself, which would leave the match off-screen.
   * Smooth scrollIntoView queues browser-driven animations, so hammering Enter
   * stacks them and feels laggy; this cancels the previous flight on every call.
   */
  const animateScrollTo = useCallback((target: HTMLElement | Range, block: 'center' | 'start'): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    cancelAnimationFrame(scrollAnimRef.current)

    // Bring the match into view inside nested scroll containers between it and
    // the transcript scroller (e.g. a tool argument's <pre> with its own
    // max-height scroll area), inner-most first. Without this, matches below
    // such a container's first screen stay hidden behind its internal scroll.
    const alignNestedScrollers = (): void => {
      // Start at the anchor itself: the matched text's parent often IS the
      // scroll container, not merely inside one.
      const anchor = target instanceof Range ? target.startContainer.parentElement : target
      for (
        let node: HTMLElement | null = anchor;
        node && node !== scroller;
        node = node.parentElement
      ) {
        if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) continue
        const overflowY = getComputedStyle(node).overflowY
        const overflowX = getComputedStyle(node).overflowX
        if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowX !== 'auto' && overflowX !== 'scroll') continue
        const sr = node.getBoundingClientRect()
        const er = target.getBoundingClientRect()
        // The margin decides where the match lands, never whether it has to
        // move: a centred match's margin is half the container's height, so
        // reusing it as the trigger would call a match a whole screen below
        // the fold "already visible" and leave it hidden.
        if (er.top < sr.top || er.bottom > sr.bottom) {
          const margin = block === 'center' ? Math.max(0, (sr.height - er.height) / 2) : 12
          node.scrollTop += er.top - sr.top - margin
        }
        if (er.left < sr.left || er.right > sr.right) {
          node.scrollLeft += er.left - sr.left
        }
      }
    }

    const desiredTop = (): number => {
      const cr = scroller.getBoundingClientRect()
      const er = target.getBoundingClientRect()
      const margin = block === 'center' ? Math.max(0, (cr.height - er.height) / 2) : 12
      return scroller.scrollTop + (er.top - cr.top) - margin
    }

    // Content above the target can still be settling while we fly to it: a
    // Collapsible only measures its overflow once it is actually visible, via
    // ResizeObserver, so unhiding a role filter's messages can re-clip half the
    // transcript and move the target by thousands of pixels after we aimed.
    // Re-aim after each flight until the target stops drifting; the cap keeps a
    // permanently unstable layout from looping forever.
    let corrections = 0
    const fly = (): void => {
      alignNestedScrollers()
      const start = scroller.scrollTop
      const distance = desiredTop() - start
      if (Math.abs(distance) < 2) return
      const duration = Math.min(400, Math.max(150, Math.abs(distance) * 0.06))
      const begin = performance.now()
      const step = (now: number): void => {
        const p = Math.min(1, (now - begin) / duration)
        scroller.scrollTop = start + distance * (1 - Math.pow(1 - p, 3))
        if (p < 1) {
          scrollAnimRef.current = requestAnimationFrame(step)
        } else if (corrections++ < 4) {
          scrollAnimRef.current = requestAnimationFrame(fly)
        }
      }
      scrollAnimRef.current = requestAnimationFrame(step)
    }
    fly()
  }, [])

  const displayMessages = useMemo(() => mergeToolMessages(messages), [messages])
  const visibleDisplayMessages = useMemo(() => {
    if (roleFilters.size === 0) return displayMessages
    return displayMessages.filter(({ message }) => roleFilters.has(message.role))
  }, [displayMessages, roleFilters])

  /**
   * The in-transcript search and a sidebar jump paint the same two highlight
   * registrations, so exactly one of them may own those names at a time —
   * otherwise whichever effect happens to run second wipes the other's work.
   * An active Cmd+F query wins; a jump owns them only when the search box is
   * empty. Whoever owns them is also responsible for keeping them current.
   */
  const highlightOwner: 'search' | 'jump' | null = debouncedQuery.trim()
    ? 'search'
    : jumpTo != null && jumpQuery
      ? 'jump'
      : null

  const forcedExpanded = useMemo(() => {
    if (searchExpandIds.size === 0) return jumpExpandIds
    if (jumpExpandIds.size === 0) return searchExpandIds
    return new Set([...searchExpandIds, ...jumpExpandIds])
  }, [searchExpandIds, jumpExpandIds])

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

  // Jump to a message (from a sidebar search hit): open the collapsed blocks
  // holding the query's matches, highlight them, and scroll to the matched
  // text itself.
  useEffect(() => {
    if (jumpTo == null) {
      setJumpExpandIds((prev) => (prev.size === 0 ? prev : NO_FORCED_IDS))
      return
    }
    if (loading) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-idx~="${jumpTo}"]`)
    if (!el) return
    // The role filter can be hiding the very message the hit points at. Clear
    // it and let this effect re-run: a display:none element reports all-zero
    // rects, which would fling the transcript to an arbitrary offset while the
    // highlight painted nowhere — a silent, baffling failure.
    if (el.hidden) {
      setRoleFilters(new Set())
      return
    }

    // Mirror the sidebar index's term semantics so the words it matched are the
    // words highlighted here.
    const ranges = jumpQuery
      ? collectMatchRanges(el, jumpQuery, { mode: 'terms', skipHidden: false })
      : []

    // Force the matching blocks open first and bail out; the state change
    // re-runs this effect with the content laid out, so the scroll below always
    // measures final positions instead of racing the re-render.
    const ids = collapsibleIdsFor(ranges)
    if (!sameIds(jumpExpandIds, ids)) {
      setJumpExpandIds(ids)
      return
    }

    if (highlightOwner === 'jump' && CSS.highlights && ranges.length > 0) {
      const toHighlight = ranges.length <= MAX_HIGHLIGHTS ? ranges : ranges.slice(0, MAX_HIGHLIGHTS)
      CSS.highlights.set('transcript-search', new Highlight(...toHighlight))
      CSS.highlights.set('transcript-search-current', new Highlight(ranges[0]))
    }

    // A precise range scrolls to the matched text itself, even inside a long
    // tool output that scrolls internally.
    animateScrollTo(ranges[0] ?? el, 'start')
    el.classList.add('flash')
    const t = setTimeout(() => el.classList.remove('flash'), 1600)
    return () => {
      clearTimeout(t)
      el.classList.remove('flash')
    }
  }, [
    loading,
    jumpTo,
    jumpQuery,
    jumpNonce,
    jumpExpandIds,
    highlightOwner,
    visibleDisplayMessages,
    animateScrollTo
  ])

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
    matchRangesRef.current = []

    if (!debouncedQuery.trim() || !scrollRef.current) {
      setTotalMatches(0)
      setSearchExpandIds((prev) => (prev.size === 0 ? prev : NO_FORCED_IDS))
      // Leave the registrations alone: with no query this effect no longer owns
      // them, and a sidebar jump may be the one painting.
      return
    }
    CSS.highlights.delete('transcript-search')
    CSS.highlights.delete('transcript-search-current')

    // Cmd+F matches the query literally, the way every other find-in-page does.
    const ranges = collectMatchRanges(scrollRef.current, debouncedQuery, {
      mode: 'phrase',
      skipHidden: true
    })

    matchRangesRef.current = ranges
    setTotalMatches(ranges.length)
    setCurrentMatch((prev) => (ranges.length > 0 ? Math.min(prev, ranges.length - 1) : 0))
    // Open only the blocks that actually hold a match, from the full range list
    // rather than the highlighted slice — navigation can still reach match 501.
    setSearchExpandIds((prev) => {
      const ids = collapsibleIdsFor(ranges)
      return sameIds(prev, ids) ? prev : ids
    })

    if (ranges.length > 0) {
      const toHighlight = ranges.length <= MAX_HIGHLIGHTS ? ranges : ranges.slice(0, MAX_HIGHLIGHTS)
      CSS.highlights.set('transcript-search', new Highlight(...toHighlight))
    }
  }, [debouncedQuery, visibleDisplayMessages, viewRevision])

  // Highlight + scroll to the current match
  useEffect(() => {
    if (!CSS.highlights || highlightOwner !== 'search') return
    CSS.highlights.delete('transcript-search-current')

    const ranges = matchRangesRef.current
    if (ranges.length === 0 || currentMatch >= ranges.length) return

    const range = ranges[currentMatch]
    CSS.highlights.set('transcript-search-current', new Highlight(range))

    if (!scrollRef.current) return
    // Position by the range itself so the matched text (not its container)
    // lands on screen, including inside nested scroll areas like tool outputs.
    // searchExpandIds is a dependency because opening blocks moves every match
    // below them; re-running settles the current one at its final position.
    animateScrollTo(range, 'center')
  }, [currentMatch, totalMatches, searchExpandIds, highlightOwner, animateScrollTo])

  // Nobody is painting: drop whatever the last owner left behind.
  useEffect(() => {
    if (highlightOwner !== null) return
    CSS.highlights?.delete('transcript-search')
    CSS.highlights?.delete('transcript-search-current')
  }, [highlightOwner])

  // Clean up highlights and any in-flight scroll animation on unmount
  useEffect(() => {
    return () => {
      CSS.highlights?.delete('transcript-search')
      CSS.highlights?.delete('transcript-search-current')
      cancelAnimationFrame(scrollAnimRef.current)
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

  async function onExport(): Promise<void> {
    if (!transcriptRef.current || !meta) return
    // The export clones the live DOM, so blocks forced open by an active search
    // would be baked in expanded — and without their toggle, which is not
    // rendered while forced. Collapse them back before cloning, restore after.
    const forcedBeforeExport = { search: searchExpandIds, jump: jumpExpandIds }
    const clearForced = forcedBeforeExport.search.size > 0 || forcedBeforeExport.jump.size > 0
    if (clearForced) {
      flushSync(() => {
        setSearchExpandIds(NO_FORCED_IDS)
        setJumpExpandIds(NO_FORCED_IDS)
      })
    }
    try {
      setToast('Preparing HTML export…')
      if (!subAgent && meta.subAgents.length > 0) {
        const loaded = await Promise.all(
          meta.subAgents.map(async (agent) => ({
            meta: agent,
            messages: (await api.loadSubAgent(agent.sourcePath)).messages
          }))
        )
        setExportSubAgents(loaded)
        // Wait for React to render the export-only sections before cloning the DOM.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      }
      const title = subAgent ? subAgent.label : meta.title
      const html = await buildTranscriptHtml(transcriptRef.current, title)
      const safeName = title.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'transcript'
      const result = await api.exportTranscriptHtml(html, `${safeName}.html`)
      setToast(result.canceled ? '' : 'Transcript exported ✓')
      if (!result.canceled) setTimeout(() => setToast(''), 3000)
    } catch (error) {
      setToast(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      setTimeout(() => setToast(''), 5000)
    } finally {
      setExportSubAgents([])
      if (clearForced) {
        setSearchExpandIds(forcedBeforeExport.search)
        setJumpExpandIds(forcedBeforeExport.jump)
      }
    }
  }

  if (loading) return <div className="transcript empty">Loading…</div>
  if (!meta) return <div className="transcript empty">Session not found</div>

  const agent = AGENT_META[meta.agent]
  const hasSubs = meta.subAgents.length > 0

  return (
    <div
      className={`transcript${exportSubAgents.length > 0 ? ' has-export-subagents' : ''}`}
      data-export-main-title={meta.title}
      data-export-main-count={meta.messageCount}
      ref={transcriptRef}
    >
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
        {!subAgent && (
          <div className="th-back export-subagent-back" hidden>
            <button className="btn btn-back" data-export-back>
              <ArrowLeft size={14} /> Back to main session
            </button>
            <span className="th-sub-label">
              <Bot size={13} /> <span data-export-subagent-label />
            </span>
          </div>
        )}
        <div className="th-main">
          <span className="agent-badge" style={{ background: agent.color }}>
            {agent.label}
          </span>
          <h2 title={subAgent ? subAgent.label : meta.title} data-export-title>
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
          <span data-export-message-count>
            {subAgent ? subAgent.messageCount : meta.messageCount} msgs
          </span>
          <span className="th-dot">·</span>
          <span>{fullTime(meta.updatedAt)}</span>
        </div>
        {!subAgent && (
          <div className="th-actions">
            <button className="btn primary app-only-action" onClick={onResume}>
              <Play size={14} /> Resume in Ghostty
            </button>
            <button
              className="btn app-only-action"
              onClick={async () => {
                await api.copyResumeCommand(sessionId)
                setToast('Resume command copied')
                setTimeout(() => setToast(''), 2500)
              }}
            >
              Copy command
            </button>
            <button className="btn export-action" onClick={() => void onExport()}>
              <Download size={14} /> Export HTML
            </button>
          </div>
        )}
        {subAgent && (
          <div className="th-actions">
            <button className="btn export-action" onClick={() => void onExport()}>
              <Download size={14} /> Export HTML
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
                data-export-subagent={sa.id}
                data-export-label={sa.label}
                data-export-count={sa.messageCount}
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
            data-filter-role=""
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
              data-filter-role={role}
              data-filter-color={ROLE_META[role].color}
            >
              {ROLE_META[role].label}
            </button>
          ))}
          <span className="message-filter-count">
            {visibleDisplayMessages.length}/{displayMessages.length}
          </span>
        </div>
      </header>

      <div className="transcript-search-bar" hidden={!showSearch}>
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
          <span className="ts-count" hidden={!searchQuery}>
            {totalMatches > 0 ? `${currentMatch + 1}/${totalMatches}` : 'No matches'}
          </span>
          <button
            className="ts-nav"
            onClick={() => goToMatch(-1)}
            disabled={totalMatches === 0}
            title="Previous match (Shift+Enter)"
            data-search-prev
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="ts-nav"
            onClick={() => goToMatch(1)}
            disabled={totalMatches === 0}
            title="Next match (Enter)"
            data-search-next
          >
            <ChevronDown size={15} />
          </button>
          <button className="ts-nav" onClick={closeSearch} title="Close (Esc)" data-search-close>
            <X size={15} />
          </button>
        </div>

      <div className="transcript-scroll" ref={scrollRef}>
        <CollapseContext.Provider value={forcedExpanded}>
        <section data-export-session="main">
          {displayMessages.map(({ key, message, relatedIdxs }) => (
            <div
              key={key}
              data-idx={relatedIdxs.join(' ')}
              data-message-role={message.role}
              hidden={roleFilters.size > 0 && !roleFilters.has(message.role)}
            >
              <MessageItem message={message} onViewChange={() => setViewRevision((value) => value + 1)} />
            </div>
          ))}
          {messages.length === 0 && <div className="empty">No renderable messages</div>}
          {messages.length > 0 && visibleDisplayMessages.length === 0 && (
            <div className="empty filter-empty">No messages match this filter</div>
          )}
        </section>
        {!subAgent && exportSubAgents.length > 0 && (
          <div className="export-subagents">
            {exportSubAgents.map((agent) => (
              <ExportSubAgentSection key={agent.meta.sourcePath} {...agent} />
            ))}
          </div>
        )}
        </CollapseContext.Provider>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
