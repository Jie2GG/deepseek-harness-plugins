/** Short-lived job table for the flows a settings page must watch: sign-in and install. @module dsh-plugin-github/jobs */

import type { GhFailure, JobView } from './types.ts'
import { GhError } from './types.ts'

/** Lines kept per job, newest last. */
const MAX_LOG_LINES = 200

/** How long a finished job stays pollable, so a slow page still reads its last state. */
const KEEP_FINISHED_MS = 10 * 60_000

/** Progress and cancellation handed to a job body. */
export interface JobApi {
  /** Append one progress line. */
  log(line: string): void
  /** Cancellation the job body must forward to its own awaited work. */
  signal: AbortSignal
  /** Publish the device-flow code and URL as soon as they are known. */
  publish(patch: { code?: string; url?: string }): void
}

/** One running or finished job, as the page polls it. */
interface JobRecord {
  id: string
  label: string
  state: JobView['state']
  log: string[]
  startedAt: number
  endedAt?: number
  code?: string
  url?: string
  result?: unknown
  error?: GhFailure
  controller: AbortController
}

/** Convert any thrown value into the failure shape the page renders. */
function failureOf(error: unknown, aborted: boolean): GhFailure {
  if (error instanceof GhError) return { code: error.code, message: error.message, ...error.hint === undefined ? {} : { hint: error.hint } }
  if (aborted) return { code: 'timeout', message: error instanceof Error ? error.message : String(error) }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** Short-lived jobs owned by one plugin activation; disposal cancels every running one. */
export class JobTable {
  private readonly jobs = new Map<string, JobRecord>()
  private sequence = 0

  /** Count of jobs still running, which the page uses to disable conflicting actions. */
  get running(): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.state === 'running') count += 1
    return count
  }

  /**
   * Start one job and return its id before any of its work settles.
   * @param label - short name shown in the page and in refusals.
   * @param run - job body; it must observe `api.signal` and settle when aborted.
   * @returns the job id the page polls with.
   * @throws {GhError} `busy` when a job of the same label is already running.
   */
  start(label: string, run: (api: JobApi) => Promise<unknown>): string {
    for (const job of this.jobs.values()) {
      if (job.state === 'running' && job.label === label) throw new GhError('busy', `${label} is already running.`, 'Wait for it to finish, or cancel it first.')
    }
    this.prune()
    this.sequence += 1
    const id = `${Date.now().toString(36)}-${this.sequence.toString(36)}`
    const controller = new AbortController()
    const record: JobRecord = { id, label, state: 'running', log: [], startedAt: Date.now(), controller }
    this.jobs.set(id, record)
    const api: JobApi = {
      log: (line: string): void => {
        record.log.push(line)
        if (record.log.length > MAX_LOG_LINES) record.log.splice(0, record.log.length - MAX_LOG_LINES)
      },
      signal: controller.signal,
      publish: (patch: { code?: string; url?: string }): void => {
        if (patch.code !== undefined) record.code = patch.code
        if (patch.url !== undefined) record.url = patch.url
      },
    }
    void run(api)
      .then((result): void => {
        record.state = 'succeeded'
        record.result = result
      })
      .catch((error: unknown): void => {
        if (controller.signal.aborted && record.state === 'cancelled') return
        record.state = 'failed'
        record.error = failureOf(error, controller.signal.aborted)
      })
      .finally((): void => {
        record.endedAt = Date.now()
      })
    return id
  }

  /**
   * Read one job's current state.
   * @param id - id returned by {@link start}.
   * @returns the view, or `undefined` when the job was never known or has been pruned —
   *   including after a configuration write restarted this plugin, which the page treats as "reload".
   */
  poll(id: string): JobView | undefined {
    const record = this.jobs.get(id)
    if (record === undefined) return undefined
    return this.view(record)
  }

  /**
   * Ask one running job to stop.
   * @param id - job to cancel.
   * @returns the settled view, or `undefined` when nothing matches that id.
   */
  cancel(id: string): JobView | undefined {
    const record = this.jobs.get(id)
    if (record === undefined) return undefined
    if (record.state === 'running') {
      record.state = 'cancelled'
      record.log.push('Cancellation requested.')
      record.controller.abort()
    }
    return this.view(record)
  }

  /**
   * Snapshot every job the page may still be watching.
   * @returns jobs in start order.
   */
  list(): JobView[] {
    return [...this.jobs.values()].map(record => this.view(record))
  }

  /** Cancel every running job, called when this plugin activation is torn down. */
  dispose(): void {
    for (const record of this.jobs.values()) {
      if (record.state !== 'running') continue
      record.state = 'cancelled'
      record.controller.abort()
    }
  }

  /** Project one record into the page-facing view. */
  private view(record: JobRecord): JobView {
    return {
      id: record.id,
      label: record.label,
      state: record.state,
      log: [...record.log],
      startedAt: record.startedAt,
      ...record.endedAt === undefined ? {} : { endedAt: record.endedAt },
      ...record.code === undefined ? {} : { code: record.code },
      ...record.url === undefined ? {} : { url: record.url },
      ...record.result === undefined ? {} : { result: record.result },
      ...record.error === undefined ? {} : { error: record.error },
    }
  }

  /** Drop finished jobs older than the retention window. */
  private prune(): void {
    const cutoff = Date.now() - KEEP_FINISHED_MS
    for (const [id, record] of this.jobs) {
      if (record.state !== 'running' && (record.endedAt ?? record.startedAt) < cutoff) this.jobs.delete(id)
    }
  }
}
