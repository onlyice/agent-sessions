import { Marked } from 'marked'

const markdown = new Marked({ gfm: true, breaks: true })
const instructionMarkdown = new Marked({
  gfm: true,
  breaks: true,
  // Instruction wrappers such as <permissions instructions> are transcript
  // text. Disable HTML tokenization so their contents still receive normal
  // Markdown parsing, including line breaks, lists and fenced code blocks.
  tokenizer: {
    html: () => undefined,
    tag: () => undefined
  }
})

export function renderMarkdown(text: string, literalHtml = false): string {
  return (literalHtml ? instructionMarkdown : markdown).parse(text, { async: false })
}
