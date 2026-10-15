import { parse, type Node } from 'acorn'
import { stringify } from './util'

type SyntaxNode = Node & Record<string, any>

/** Read literal arguments without ever executing transcript JavaScript. */
function literal(node: SyntaxNode, source: string): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value
    case 'TemplateLiteral':
      if (node.expressions.length === 0) return node.quasis[0].value.cooked
      break
    case 'ObjectExpression':
      if (node.properties.every((p: SyntaxNode) => p.type === 'Property' && !p.computed && p.kind === 'init')) {
        return Object.fromEntries(node.properties.map((p: SyntaxNode) => [
          p.key.name ?? p.key.value,
          literal(p.value, source)
        ]))
      }
      break
    case 'ArrayExpression':
      return node.elements.map((item: SyntaxNode | null) => item ? literal(item, source) : null)
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value
      }
      break
  }
  // Variables, interpolations and other expressions stay visible as source.
  return source.slice(node.start, node.end)
}

export function customToolInput(name: string, input: unknown): unknown {
  if (name !== 'exec' || typeof input !== 'string') return input
  try {
    const tree = parse(input, { ecmaVersion: 'latest', sourceType: 'module' })
    const calls: { name: string; arguments: unknown }[] = []
    const visit = (node: SyntaxNode): void => {
      if (node.type === 'CallExpression') {
        const callee = node.callee
        if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'tools') {
          const toolName = callee.computed ? callee.property.value : callee.property.name
          if (typeof toolName === 'string') {
            calls.push({
              name: toolName,
              arguments: node.arguments.length === 1
                ? literal(node.arguments[0], input)
                : node.arguments.map((arg: SyntaxNode) => literal(arg, input))
            })
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child.type === 'string') visit(child)
        } else if (value && typeof value === 'object' && typeof value.type === 'string') {
          visit(value)
        }
      }
    }
    visit(tree as SyntaxNode)
    return calls.length ? { calls, input } : input
  } catch {
    // Incomplete scripts or future syntax must still be readable.
    return input
  }
}

interface ToolOutput {
  text: string
  exitCode?: number
  toolResult?: unknown
  isError?: boolean
}

export function parseToolOutput(output: unknown): ToolOutput {
  const parts = Array.isArray(output) ? output : [output]
  const texts: string[] = []
  const results: unknown[] = []
  const exitCodes: number[] = []
  let isError = false
  for (const part of parts) {
    let value = part && typeof part === 'object' && typeof part.text === 'string' ? part.text : part
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { /* plain text output */ }
    }
    results.push(value)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      isError ||= value.isError === true
      if (typeof value.exit_code === 'number') exitCodes.push(value.exit_code)
      if ('output' in value && ('exit_code' in value || 'wall_time_seconds' in value || 'session_id' in value || 'chunk_id' in value)) {
        // Command stdout is opaque text, even when it happens to contain JSON.
        texts.push(typeof value.output === 'string' ? value.output : stringify(value.output))
        continue
      }
      if (Array.isArray(value.content)) {
        const parsed = parseToolOutput(value.content)
        texts.push(parsed.text)
        if (parsed.exitCode != null) exitCodes.push(parsed.exitCode)
        isError ||= parsed.isError === true
        continue
      }
    }
    if (value == null) continue
    // Keep wrapper status text, non-JSON text and unsupported content blocks.
    const raw = typeof value === 'string' ? value : stringify(value)
    const lines = raw.split('\n')
    const outputIndex = lines.findIndex((line, index) => index <= 8 && line === 'Output:')
    const header = lines.slice(0, outputIndex)
    if (outputIndex >= 0 && header.some((line) => /^Chunk ID: \S+/.test(line))) {
      const exitLine = header.find((line) => /^Process exited with code -?\d+$/.test(line))
      if (exitLine) exitCodes.push(Number(exitLine.match(/-?\d+$/)?.[0]))
      texts.push(lines.slice(outputIndex + 1).join('\n'))
    } else {
      texts.push(raw)
    }
  }
  // A wrapper can return multiple commands. Surface any failure, preserving all
  // individual results and exit codes in toolResult.
  const exitCode = exitCodes.find((code) => code !== 0) ?? exitCodes[0]
  return {
    text: texts.filter((text) => text.length > 0).join('\n'),
    exitCode,
    toolResult: Array.isArray(output) ? results : results[0],
    isError: isError || (exitCode != null && exitCode !== 0) || undefined
  }
}
