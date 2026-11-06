import { useId, useState } from 'react'
import { ChevronDown, ChevronUp, List } from 'lucide-react'
import type { Message } from '../types'
import { messageLabel } from '../util'

interface TocEntry {
  key: string
  message: Message
}

export function MessageToc<Entry extends TocEntry>({
  entries,
  selectedKey,
  onSelect
}: {
  entries: Entry[]
  selectedKey: string | null
  onSelect: (entry: Entry) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (entries.length === 0) return null

  return (
    <nav className={`message-toc app-only-action${open ? ' open' : ''}`} aria-label="Message table of contents">
      <button
        className="message-toc-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <List size={16} />
        <span>TOC</span>
        <span className="message-toc-count">{entries.length}</span>
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      <ol id={listId} className="message-toc-list" hidden={!open}>
        {open && entries.map((entry, index) => {
          const { message } = entry
          const label = messageLabel(message)
          const preview = message.text.replace(/\s+/g, ' ').trim() ||
            message.blocks.map((block) => block.kind === 'image' ? '[Image]' : block.kind === 'file' ? '[File]' : '').filter(Boolean).join(' ') ||
            '(No text)'
          return (
            <li key={entry.key}>
              <button
                className="message-toc-item"
                aria-current={selectedKey === entry.key ? 'location' : undefined}
                title={`${label.label}: ${preview.slice(0, 500)}`}
                onClick={() => onSelect(entry)}
              >
                <span className="message-toc-item-meta">
                  <span style={{ color: label.color }}>{label.label}</span>
                  <span>#{index + 1}</span>
                </span>
                <span className="message-toc-preview">{preview.slice(0, 160)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
