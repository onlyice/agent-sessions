import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

// Open links in the user's browser instead of navigating the renderer window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Render trusted-but-arbitrary transcript text as sanitized Markdown. */
export function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(rendered)
  }, [text])
  return (
    <div
      className={`md${className ? ' ' + className : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
