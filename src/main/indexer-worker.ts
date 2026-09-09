/**
 * Indexer entry point for the Electron utility process (see index-service.ts).
 *
 * Scanning transcripts means reading and JSON-parsing gigabytes of JSONL, and
 * writing the FTS rows is more CPU still. On the main process that work blocks
 * every IPC reply and window event — the app looks frozen for as long as it
 * runs — so it lives here instead, talking to the same SQLite file over WAL.
 */
import type { ParentPort } from 'electron'
import { IndexDB } from './db'
import { reindex } from './indexer'
import type { Vault } from './types'

export interface ReindexRequest {
  type: 'reindex'
  id: number
  dbPath: string
  vaults: Vault[]
}

const parentPort = process.parentPort as ParentPort

let db: IndexDB | null = null
// Requests are handled one at a time: two concurrent passes would fight over
// the same rows and duplicate all the parsing.
let queue: Promise<unknown> = Promise.resolve()

function openDb(path: string): IndexDB {
  db ??= new IndexDB(path)
  return db
}

async function handle(request: ReindexRequest): Promise<void> {
  try {
    const result = await reindex(openDb(request.dbPath), request.vaults, (progress) =>
      parentPort.postMessage({ type: 'progress', progress })
    )
    parentPort.postMessage({ type: 'done', id: request.id, result })
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

parentPort.on('message', (event) => {
  const request = event.data as ReindexRequest
  if (request?.type !== 'reindex') return
  queue = queue.then(() => handle(request))
})
