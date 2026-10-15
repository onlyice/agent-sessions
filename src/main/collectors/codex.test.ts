import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexCollector } from './codex'
import { customToolInput, parseToolOutput } from './codex-tools'

test('custom scripts retain source and statically extract multiple tool calls', () => {
  const input = 'text(await tools.exec_command({cmd:"printf \\\"hi\\\"", max_output_tokens:2000})); await tools["write_stdin"]({session_id:123, chars:``})'
  assert.deepEqual(customToolInput('exec', input), {
    input,
    calls: [
      { name: 'exec_command', arguments: { cmd: 'printf "hi"', max_output_tokens: 2000 } },
      { name: 'write_stdin', arguments: { session_id: 123, chars: '' } }
    ]
  })
  assert.equal(customToolInput('apply_patch', '*** Begin Patch'), '*** Begin Patch')
  assert.equal(customToolInput('exec', 'await tools.exec_command({'), 'await tools.exec_command({')
  assert.equal(customToolInput('exec', 'throw new Error("must not execute")'), 'throw new Error("must not execute")')
})

test('custom output supports arbitrary text block positions, multiple commands and malformed JSON', () => {
  const result = parseToolOutput([
    { type: 'text', text: 'Script completed\nWall time: 0.2 seconds' },
    { type: 'text', text: JSON.stringify({ exit_code: 1, output: '404 Project Not Found', wall_time_seconds: 0.1 }) },
    { type: 'text', text: '{malformed JSON' },
    { type: 'text', text: JSON.stringify({ exit_code: 0, output: '' }) }
  ])
  assert.equal(result.exitCode, 1)
  assert.equal(result.isError, true)
  assert.match(result.text, /404 Project Not Found/)
  assert.match(result.text, /\{malformed JSON/)
  assert.equal((result.toolResult as unknown[]).length, 4)
  assert.equal(parseToolOutput({ exit_code: 0, output: '' }).exitCode, 0)
  const stdout = '{\n  "exit_code": 9,\n  "output": "this is stdout"\n}\n'
  const jsonOutput = parseToolOutput({ exit_code: 0, output: stdout })
  assert.equal(jsonOutput.text, stdout)
  assert.equal(jsonOutput.exitCode, 0)
  assert.equal(parseToolOutput({ isError: true, content: [{ type: 'text', text: 'failure' }] }).isError, true)
})

test('legacy command headers and structured user answers remain readable', () => {
  const result = parseToolOutput('Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nfailed\n')
  assert.equal(result.exitCode, 2)
  assert.equal(result.text, 'failed\n')
  const answer = { answers: { choice: { answers: ['yes'] } } }
  assert.deepEqual(parseToolOutput(JSON.stringify(answer)).toolResult, answer)
})

test('mixed rollouts preserve custom and function calls with matching call IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-transcript-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    const items = [
      { type: 'world_state', payload: { ignored: true } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'help' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'custom', input: 'text(await tools.exec_command({cmd:"pwd"}))' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom', output: [{ type: 'text', text: JSON.stringify({ exit_code: 0, output: '/tmp' }) }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'legacy', arguments: '{"cmd":"false"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'legacy', output: 'Chunk ID: abc\nProcess exited with code 1\nOutput:\n' } }
    ]
    await writeFile(path, items.map((item) => JSON.stringify(item)).join('\n'))
    const messages = await codexCollector.load(path)
    assert.deepEqual(messages.map((message) => message.role), ['user', 'tool', 'tool', 'tool', 'tool'])
    assert.deepEqual(messages.slice(1).map((message) => message.blocks[0].toolCallId), ['custom', 'custom', 'legacy', 'legacy'])
    assert.match(messages[1].text, /pwd/)
    assert.equal(messages[2].text, '/tmp')
    assert.equal(messages[2].blocks[0].exitCode, 0)
    assert.equal(messages[4].blocks[0].exitCode, 1)
    assert.equal(messages[4].blocks[0].isError, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
