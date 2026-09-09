import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import type { IndexDB } from './db'
import { reindex, type IndexProgress, type IndexResult } from './indexer'
import type { Vault } from './types'
import type { ReindexRequest } from './indexer-worker'

type WorkerMessage =
  | { type: 'progress'; progress: IndexProgress }
  | { type: 'done'; id: number; result: IndexResult }
  | { type: 'error'; id: number; message: string }

/**
 * Owns the indexing pass. Work is handed to a long-lived utility process so the
 * main process stays responsive while gigabytes of transcripts are parsed; if
 * that process can't be started (or dies), indexing falls back to running here,
 * which is slower to live with but never leaves the index stale.
 */
export class IndexService {
  private worker: Promise<UtilityProcess> | null = null
  private workerUsable = true
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (result: IndexResult) => void; reject: (error: Error) => void }
  >()
  /** Serializes passes: overlapping ones would duplicate every parse. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly db: IndexDB,
    private readonly dbPath: string,
    private readonly onProgress: (progress: IndexProgress) => void
  ) {}

  run(vaults: Vault[]): Promise<IndexResult> {
    const next = this.queue.then(
      () => this.runOnce(vaults),
      () => this.runOnce(vaults)
    )
    this.queue = next.catch(() => undefined)
    return next
  }

  dispose(): void {
    this.disposed = true
    void this.worker?.then((worker) => worker.kill()).catch(() => undefined)
    this.worker = null
  }

  private async runOnce(vaults: Vault[]): Promise<IndexResult> {
    if (this.workerUsable && !this.disposed) {
      try {
        return await this.runInWorker(vaults)
      } catch (err) {
        // One bad start is enough to stop trying: retrying per pass would just
        // pay the fork cost every few minutes for the life of the app.
        this.workerUsable = false
        console.error('[indexer] utility process unavailable, indexing in-process:', err)
      }
    }
    return reindex(this.db, vaults, this.onProgress)
  }

  private async runInWorker(vaults: Vault[]): Promise<IndexResult> {
    const worker = await this.spawn()
    const id = this.nextId++
    return new Promise<IndexResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const request: ReindexRequest = { type: 'reindex', id, dbPath: this.dbPath, vaults }
      worker.postMessage(request)
    })
  }

  private spawn(): Promise<UtilityProcess> {
    this.worker ??= new Promise<UtilityProcess>((resolve, reject) => {
      const worker = utilityProcess.fork(join(__dirname, 'indexer-worker.mjs'), [], {
        serviceName: 'agent-sessions-indexer',
        stdio: 'inherit'
      })
      worker.on('message', (message: WorkerMessage) => this.receive(message))
      worker.once('spawn', () => resolve(worker))
      worker.once('exit', (code) => {
        this.worker = null
        const error = new Error(`indexer process exited (code ${code})`)
        reject(error)
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
      })
    })
    return this.worker
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'progress') {
      this.onProgress(message.progress)
      return
    }
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.type === 'done') request.resolve(message.result)
    else request.reject(new Error(message.message))
  }
}
