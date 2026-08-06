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
  // A fresh `{ __html }` object per render would make React re-set innerHTML on
  // every parent re-render, replacing the text nodes that search highlights
  // (CSS Custom Highlight ranges) point at. Cache the props object so React
  // can tell the content is unchanged.
  const dangerouslySetInnerHTML = useMemo(() => ({ __html: html }), [html])
  return (
    <div
      className={`md${className ? ' ' + className : ''}`}
      dangerouslySetInnerHTML={dangerouslySetInnerHTML}
    />
  )
}
