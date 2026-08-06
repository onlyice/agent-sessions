import { useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Code, FileText, Image, Paperclip } from 'lucide-react'
import type { Block, Message } from '../types'
import { formatDuration, fullTime, messageLabel } from '../util'
import { CollapseContext } from '../collapseContext'
import { Markdown } from './Markdown'

type TextView = 'markdown' | 'source'

/** Collapse height (~10 text lines) before the Show more / less control appears. */
const COLLAPSED_MAX = 250

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ToolValueField({ name, value }: { name: string; value: unknown }): React.JSX.Element {
  const isText = typeof value === 'string'
  const text = formatToolValue(value)
  const isMultilineText = isText && text.includes('\n')
  const shouldUseMultiline = isMultilineText || isRecord(value) || Array.isArray(value)

  // Render values as plain elements rather than <input>/<textarea>: form
  // control contents cannot be painted by the CSS Custom Highlight API (and
  // <input> values aren't even text nodes), so tool-input parameters would
  // never show up in search. With no form control left, <label> would be an
  // empty shell, so this is a plain <div>.
  return (
    <div className="tool-field">
      <span className="tool-field-name">{name}</span>
      {shouldUseMultiline ? (
        <pre className="tool-field-value multi">{text}</pre>
      ) : (
        <div className="tool-field-value">{text}</div>
      )}
    </div>
  )
}

function ToolInput({ value }: { value: unknown }): React.JSX.Element {
  const entries = isRecord(value) ? Object.entries(value) : [['input', value] as const]

  if (entries.length === 0) {
    return <div className="tool-empty">No input</div>
  }

  return (
    <form className="tool-input-form">
      {entries.map(([name, fieldValue]) => (
        <ToolValueField key={name} name={name} value={fieldValue} />
      ))}
    </form>
  )
}

interface UserQuestionOption {
  label: string
  description?: string
}

interface UserQuestion {
  id?: string
  header?: string
  question: string
  multiSelect: boolean
  options: UserQuestionOption[]
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function userQuestions(value: unknown): UserQuestion[] | null {
  const input = parseJson(value)
  if (!isRecord(input)) return null
  const rawQuestions = parseJson(input.questions)
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const questions: UserQuestion[] = []
  for (const raw of rawQuestions) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || !raw.question.trim()) return null
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    const options: UserQuestionOption[] = []
    for (const option of rawOptions) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) return null
      options.push({
        label: option.label,
        description: typeof option.description === 'string' ? option.description : undefined
      })
    }
    questions.push({
      id: typeof raw.id === 'string' ? raw.id : undefined,
      header: typeof raw.header === 'string' ? raw.header : undefined,
      question: raw.question,
      multiSelect: raw.multiSelect === true,
      options
    })
  }
  return questions
}

function questionAnswers(question: UserQuestion, result: unknown): string[] {
  const parsed = parseJson(result)
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return []
  const answer = parsed.answers[question.id ?? question.question]
  if (typeof answer === 'string') return [answer]
  if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === 'string')
  if (isRecord(answer) && Array.isArray(answer.answers)) {
    return answer.answers.filter((value): value is string => typeof value === 'string')
  }
  return []
}

function UserQuestionBlock({
  questions,
  output
}: {
  questions: UserQuestion[]
  output?: Block
}): React.JSX.Element {
  return (
    <div className="tool-block question-block">
      <div className="tool-head question-head">
        <span className="tool-name">Asked user</span>
        <span className="question-count">
          {questions.length} {questions.length === 1 ? 'question' : 'questions'}
        </span>
      </div>
      <div className="question-list">
        {questions.map((question, index) => {
          const answers = questionAnswers(question, output?.toolResult)
          const optionLabels = new Set(question.options.map((option) => option.label))
          const customAnswers = answers.filter((answer) => !optionLabels.has(answer))
          return (
            <section className="question-item" key={question.id ?? `${index}-${question.question}`}>
              <div className="question-meta">
                {question.header && <span className="question-header">{question.header}</span>}
                <span>{question.multiSelect ? 'Select multiple' : 'Select one'}</span>
              </div>
              <div className="question-text">{question.question}</div>
              {question.options.length > 0 && (
                <div className="question-options">
                  {question.options.map((option) => {
                    const selected = answers.includes(option.label)
                    return (
                      <div className={`question-option${selected ? ' selected' : ''}`} key={option.label}>
                        <span className={`question-marker${question.multiSelect ? ' square' : ''}`} aria-hidden="true">
                          {selected ? '✓' : ''}
                        </span>
                        <span className="question-option-copy">
                          <span className="question-option-label">{option.label}</span>
                          {option.description && (
                            <span className="question-option-description">{option.description}</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {customAnswers.map((answer) => (
                <div className="question-custom-answer" key={answer}>
                  <span>Answer</span>
                  <div>{answer}</div>
                </div>
              ))}
            </section>
          )
        })}
      </div>
      {output?.text && questions.every((question) => questionAnswers(question, output.toolResult).length === 0) && (
        <div className="question-result">{output.text}</div>
      )}
    </div>
  )
}

function ToolBlock({ input, output }: { input?: Block; output?: Block }): React.JSX.Element {
  const toolName = input?.toolName?.trim() || output?.toolName?.trim() || 'Tool'
  const questions =
    input && (toolName === 'AskUserQuestion' || toolName === 'request_user_input')
      ? userQuestions(input.toolInput)
      : null
  if (questions) return <UserQuestionBlock questions={questions} output={output} />

  const title = output?.isError ? `${toolName} (error)` : toolName
  const exitCode = output?.exitCode

  return (
    <div className={`tool-block ${input ? 'tool-use' : 'tool-result'}`}>
      <div className="tool-head">
        <span className={`tool-name ${!input ? 'result' : ''} ${output?.isError ? 'err' : ''}`}>{title}</span>
        {exitCode != null && (
          <span className={`tool-exit-code ${exitCode === 0 ? 'ok' : 'err'}`}>exit {exitCode}</span>
        )}
      </div>
      {input && <ToolInput value={input.toolInput} />}
      {output?.text && <pre className="tool-body">{output.text}</pre>}
    </div>
  )
}

function TextBlock({ block }: { block: Block }): React.JSX.Element {
  const thinking = block.kind === 'thinking'
  const text = block.text ?? ''
  return (
    <>
      <div className="text-view-markdown">
        <Markdown className={thinking ? 'block-thinking' : 'block-text'} text={text} />
      </div>
      <pre className={`text-view-source block-source${thinking ? ' thinking' : ''}`}>{text}</pre>
    </>
  )
}

function BlockView({ block }: { block: Block }): React.JSX.Element | null {
  switch (block.kind) {
    case 'text':
    case 'thinking':
      return <TextBlock block={block} />
    case 'tool_use':
      return <ToolBlock input={block} />
    case 'tool_result':
      return <ToolBlock output={block} />
    case 'image':
      return (
        <div className="block-meta">
          <Image size={14} /> {block.text}
        </div>
      )
    case 'file':
      return (
        <div className="block-meta">
          <Paperclip size={14} /> {block.text}
        </div>
      )
    default:
      return null
  }
}

function BlocksView({ blocks }: { blocks: Block[] }): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const next = blocks[i + 1]
    if (block.kind === 'tool_use' && next?.kind === 'tool_result') {
      nodes.push(<ToolBlock key={i} input={block} output={next} />)
      i++
    } else {
      nodes.push(<BlockView key={i} block={block} />)
    }
  }
  return <>{nodes}</>
}

/** Clamps tall content to ~10 lines with an expand / collapse control. */
function Collapsible({ children }: { children: React.ReactNode }): React.JSX.Element {
  const innerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  // A search match or a jump target inside this block forces it open, so the
  // thing the user was pointed at can never sit behind the clip. The id lets
  // TranscriptView name this block after locating a match in the DOM.
  const id = useId()
  const forced = useContext(CollapseContext).has(id)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const check = (): void => setOverflowing(el.scrollHeight > COLLAPSED_MAX + 12)
    check()
    // Re-measure when content reflows (view toggle, async font load, nested toggles).
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const collapsed = overflowing && !expanded && !forced
  return (
    <div className="collapsible" data-collapsible-id={id}>
      <div className={`collapsible-clip${collapsed ? ' collapsed' : ''}`}>
        <div ref={innerRef}>{children}</div>
      </div>
      {/* Hidden while forced open: the toggle could not honour a click. */}
      {overflowing && !forced && (
        <button className="collapse-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? (
            <>
              <ChevronUp size={13} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={13} /> Show more
            </>
          )}
        </button>
      )}
    </div>
  )
}

export function MessageItem({
  message,
  onViewChange
}: {
  message: Message
  onViewChange?: () => void
}): React.JSX.Element {
  const label = messageLabel(message)
  const [view, setView] = useState<TextView>('markdown')
  const hasText = message.blocks.some((b) => b.kind === 'text' || b.kind === 'thinking')
  const hasTool = message.blocks.some((b) => b.kind === 'tool_use' || b.kind === 'tool_result')
  const blocks = <BlocksView blocks={message.blocks} />

  return (
    <div className={`msg msg-${message.role}${view === 'source' ? ' source-view' : ''}`}>
      <div className="msg-gutter">
        <span className="msg-role" style={{ color: label.color }}>
          {label.label}
        </span>
        {message.timestamp && <span className="msg-time">{fullTime(message.timestamp)}</span>}
        {message.toolDurationMs != null && (
          <span className="msg-duration" title="Tool execution time">
            {formatDuration(message.toolDurationMs)}
          </span>
        )}
      </div>
      <div className="msg-body">
        {hasText && (
          <div className="msg-toolbar">
            <button
              className="view-toggle"
              title="Toggle Markdown / Source"
              onClick={() => {
                setView((v) => (v === 'markdown' ? 'source' : 'markdown'))
                onViewChange?.()
              }}
            >
              {view === 'source' ? (
                <>
                  <FileText size={13} /> Markdown
                </>
              ) : (
                <>
                  <Code size={13} /> Source
                </>
              )}
            </button>
          </div>
        )}
        {hasTool ? blocks : <Collapsible>{blocks}</Collapsible>}
      </div>
    </div>
  )
}
