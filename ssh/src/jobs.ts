/**
 * Running one remote command as a background job of the harness.
 *
 * The registry hands back an id synchronously and pumps whatever output sources the
 * producer names, so a remote command started here behaves like a backgrounded
 * shell command: `job_output` reads the part that arrived since the last read,
 * `job_kill` interrupts it, and the conversation is told when it settles. The
 * connection lives in this process — a Host restart or a killed job ends the
 * remote command too, which is the trade the plugin documents rather than hides.
 *
 * The awkward shape is that `run(job)` must return its hooks synchronously while
 * resolving the executable and spawning is asynchronous. That is handled the way the
 * shipped shell tool handles it: start the work, keep a mutable reference to the
 * child, and let a cancellation that arrives first take effect the moment the child
 * exists.
 *
 * Types are stated structurally, without importing the jobs package: a plugin
 * resolves its own copy, and a nominal id type from one copy does not satisfy the
 * other. The kind is a plain string at runtime, and `'ssh'` is what this plugin's
 * ids are prefixed with.
 *
 * @module @jie2gg/dsh-plugin-ssh/jobs
 */

/** One read of a job's retained output. */
export interface JobSourceRead {
  /** Text from the requested offset. */
  text: string
  /** The offset a following read should resume from. */
  nextOffset: number
  /** Whether bytes were lost from the middle of the stream. */
  lossy: boolean
  /** Where the full output spilled to disk, when it did. */
  spillPath?: string | undefined
}

/** A stream the registry can pump into a job's output ring. */
export interface JobOutputSource {
  /** Which channel this carries. */
  channel: 'stdout' | 'stderr'
  /**
   * Read from an offset.
   * @param fromByte - the offset a previous read reported, or 0.
   * @returns the delta and its bookkeeping.
   */
  read(fromByte: number): JobSourceRead
}

/** How a job ended. */
export interface JobOutcome {
  /** Registry-visible status. */
  status: 'completed' | 'failed' | 'killed'
  /** One-line reason, shown to the reader. */
  detail?: string | undefined
  /** Handed out once, on the first read after settlement. */
  result?: string | undefined
}

/** The producer's controls for one started job. */
export interface JobHooks {
  /** Interrupt the work; called at most once per intent and never throws. */
  cancel(reason?: string): void
  /** Resolves once the producer has released everything it holds. */
  done: Promise<JobOutcome>
}

/** The face the registry passes to a starter. */
export interface JobHandle {
  /** Replace the live progress line. */
  updateProgress?: ((line: string) => void) | undefined
}

/** The job description this plugin starts with. */
export interface JobSpec {
  /** The id namespace; always `'ssh'` here. */
  kind: 'ssh'
  /** One-line label the reader sees. */
  label: string
  /** The owning conversation, which fences who may read and stop the job. */
  owner?: string | undefined
  /** The tool call that started it, kept in the durable lifecycle record. */
  toolCall?: { callId: string; rootCallId: string } | undefined
  /** Pull sources carrying the command's output. */
  output?: readonly JobOutputSource[] | undefined
  /**
   * Begin the work and return its hooks.
   * @param job - the producer face.
   * @returns the hooks the registry drives from.
   */
  run(job: JobHandle): JobHooks
}

/** The part of the job registry this plugin calls. */
export interface JobRegistry {
  /**
   * Register and start one job.
   * @param spec - what to run and who owns it.
   * @returns the id the reader uses with `job_output` and `job_kill`.
   */
  start(spec: JobSpec): string
}

/** A remote command whose child is live, as the transport hands it over. */
export interface LiveCommand {
  /** Output sources wrapped for the registry's pump. */
  sources: readonly JobOutputSource[]
  /** Interrupt the child. */
  kill(): void
  /** Resolves once the child is gone and its streams have drained. */
  finished: Promise<{
    outcome: 'exit' | 'timeout' | 'cancelled' | 'error'
    error?: string | undefined
    exitCode: number | null
    stdout: string
    stderr: string
    durationMs: number
    truncated: boolean
  }>
}

/** What a starter reports when it could not begin. */
export interface StartFailure {
  /** Why the command never started. */
  message: string
}

/**
 * Start one remote command as a job.
 * @param registry - the job registry to start into.
 * @param args - the label, the owner and tool call, and the asynchronous starter.
 * @returns the registry-issued id.
 */
export function startRemoteJob(
  registry: JobRegistry,
  args: {
    /** Text the reader sees for this job. */
    label: string
    /** The conversation that owns it. */
    owner?: string | undefined
    /** The tool call that started it. */
    toolCall?: { callId: string; rootCallId: string } | undefined
    /** Resolve the executable and spawn, or explain why that failed. */
    start: () => Promise<LiveCommand | StartFailure>
  },
): string {
  let live: LiveCommand | undefined
  let killedBy: string | undefined
  const sourceOf = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte: number) => {
      const found = live?.sources.find(entry => entry.channel === channel)
      return found === undefined ? { text: '', nextOffset: fromByte, lossy: false } : found.read(fromByte)
    },
  })
  const id = registry.start({
    kind: 'ssh',
    label: args.label,
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    ...(args.toolCall === undefined ? {} : { toolCall: args.toolCall }),
    output: [sourceOf('stdout'), sourceOf('stderr')],
    run(): JobHooks {
      const done: Promise<JobOutcome> = (async (): Promise<JobOutcome> => {
        const started = await args.start()
        if ('message' in started) {
          return { status: 'failed', detail: started.message }
        }
        live = started
        // A kill that arrived while the child was still being resolved still has to
        // reach it, or the command would run on with no one left to stop it.
        if (killedBy !== undefined) started.kill()
        const result = await started.finished
        // A cancelled client exits 255 like any other ssh failure, so the intent is
        // what classifies this: if a stop was asked for, the answer is `killed`,
        // whatever code the child reported on its way out.
        if (killedBy !== undefined) {
          return {
            status: 'killed',
            detail: killedBy,
            result: `stopped after ${String(result.durationMs)} ms${result.exitCode === null ? '' : ` (the ssh client exited ${String(result.exitCode)})`}`,
          }
        }
        if (result.outcome === 'cancelled') {
          return {
            status: 'killed',
            detail: killedBy ?? 'the job was stopped',
            result: `stopped after ${String(result.durationMs)} ms`,
          }
        }
        if (result.outcome === 'timeout') {
          return {
            status: 'failed',
            detail: 'the command ran out of its deadline',
            result: `timed out after ${String(result.durationMs)} ms`,
          }
        }
        if (result.outcome === 'error') {
          return { status: 'failed', detail: result.error ?? 'the command could not start' }
        }
        const code = result.exitCode ?? 0
        const summary = `exit=${String(code)} · ${String(result.durationMs)} ms${result.truncated === true ? ' · output truncated' : ''}`
        return code === 0
          ? { status: 'completed', detail: summary, result: summary }
          : { status: 'failed', detail: summary, result: summary }
      })().catch((error: unknown): JobOutcome => ({
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }))
      return {
        cancel(reason?: string): void {
          killedBy = reason ?? 'stopped by the reader'
          live?.kill()
        },
        done,
      }
    },
  })
  return id
}
