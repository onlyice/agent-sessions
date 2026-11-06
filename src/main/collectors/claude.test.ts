import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeCollector } from './claude'

test('messages delivered mid-turn are kept, notifications as system', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-transcript-'))
  try {
    const path = join(dir, 'session.jsonl')
    const queued = (attachment: object): object => ({
      type: 'attachment',
      timestamp: '2026-10-22T10:23:29.995Z',
      attachment: { type: 'queued_command', ...attachment }
    })
    const events = [
      { type: 'user', message: { role: 'user', content: 'plan a trip' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } },
      { type: 'queue-operation', operation: 'enqueue', content: 'add backups too' },
      queued({ prompt: 'add backups too', commandMode: 'prompt', origin: { kind: 'human' } }),
      queued({ prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification' }),
      queued({ prompt: '<task-notification>done</task-notification>', commandMode: 'prompt', origin: { kind: 'task-notification' } }),
      { type: 'attachment', attachment: { type: 'date', date: '2026-10-22' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
    ]
    await writeFile(path, events.map((event) => JSON.stringify(event)).join('\n'))
    const messages = await claudeCollector.load(path)
    assert.deepEqual(
      messages.map(({ role, text, midTurn }) => [role, text, midTurn ?? false]),
      [
        ['user', 'plan a trip', false],
        ['assistant', 'working on it', false],
        ['user', 'add backups too', true],
        ['system', '<task-notification>done</task-notification>', false],
        ['system', '<task-notification>done</task-notification>', false],
        ['assistant', 'done', false]
      ]
    )
    assert.equal(messages[2].timestamp, Date.parse('2026-10-22T10:23:29.995Z'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
