import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Code, FileText, Image, Paperclip } from 'lucide-react'
import type { Block, Message } from '../types'
import { formatDuration, fullTime, messageLabel } from '../util'
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

function fieldRows(value: unknown, text: string): number {
  const lineCount = text.length === 0 ? 1 : text.split('\n').length
  if (typeof value === 'string') return lineCount >= 3 ? 3 : lineCount
  return Math.min(Math.max(lineCount, 3), 12)
}

function ToolValueField({ name, value }: { name: string; value: unknown }): React.JSX.Element {
  const isText = typeof value === 'string'
  const text = formatToolValue(value)
  const isMultilineText = isText && text.includes('\n')
  const shouldUseTextarea = isMultilineText || isRecord(value) || Array.isArray(value)

  return (
    <label className="tool-field">
      <span className="tool-field-name">{name}</span>
      {shouldUseTextarea ? (
        <textarea
          className="tool-field-value multi"
          readOnly
          rows={fieldRows(value, text)}
          spellCheck={false}
          value={text}
          wrap="off"
        />
      ) : (
        <input className="tool-field-value" readOnly spellCheck={false} value={text} />
      )}
    </label>
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

function TextBlock({ block, view }: { block: Block; view: TextView }): React.JSX.Element {
  const thinking = block.kind === 'thinking'
  const text = block.text ?? ''
  if (view === 'source') {
    return <pre className={`block-source${thinking ? ' thinking' : ''}`}>{text}</pre>
  }
  return <Markdown className={thinking ? 'block-thinking' : 'block-text'} text={text} />
}

function BlockView({ block, view }: { block: Block; view: TextView }): React.JSX.Element | null {
  switch (block.kind) {
    case 'text':
    case 'thinking':
      return <TextBlock block={block} view={view} />
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

function BlocksView({ blocks, view }: { blocks: Block[]; view: TextView }): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const next = blocks[i + 1]
    if (block.kind === 'tool_use' && next?.kind === 'tool_result') {
      nodes.push(<ToolBlock key={i} input={block} output={next} />)
      i++
    } else {
      nodes.push(<BlockView key={i} block={block} view={view} />)
    }
  }
  return <>{nodes}</>
}

/** Clamps tall content to ~10 lines with an expand / collapse control. */
function Collapsible({ children }: { children: React.ReactNode }): React.JSX.Element {
  const innerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

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

  const collapsed = overflowing && !expanded
  return (
    <div className="collapsible">
      <div className={`collapsible-clip${collapsed ? ' collapsed' : ''}`}>
        <div ref={innerRef}>{children}</div>
      </div>
      {overflowing && (
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

export function MessageItem({ message }: { message: Message }): React.JSX.Element {
  const label = messageLabel(message)
  const [view, setView] = useState<TextView>('markdown')
  const hasText = message.blocks.some((b) => b.kind === 'text' || b.kind === 'thinking')
  const hasTool = message.blocks.some((b) => b.kind === 'tool_use' || b.kind === 'tool_result')
  const blocks = <BlocksView blocks={message.blocks} view={view} />

  return (
    <div className={`msg msg-${message.role}`}>
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
              onClick={() => setView((v) => (v === 'markdown' ? 'source' : 'markdown'))}
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
