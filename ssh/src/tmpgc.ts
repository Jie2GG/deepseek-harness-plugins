/**
 * The temp files this plugin owns, and the rule for collecting the ones its dead
 * generations left behind.
 *
 * Two things live in the system temp directory under this plugin's name: the
 * askpass helper's private directory, and the connection pool's private socket
 * directory. Both are removed when the plugin unloads, and both are therefore
 * orphaned when the process is killed instead — one crash leaves an unread
 * `askpass.sh` behind, one leaves an empty directory, and a Host that restarts
 * often enough accumulates both. The 0.0.33 round measured the residue on a live
 * machine: two askpass directories from a crashed generation and ten empty socket
 * directories, still sitting there eleven hours later, with nothing scheduled to
 * collect them.
 *
 * The collection rule is deliberately narrow, because `/tmp` is shared and this
 * is not the only program on the machine:
 *
 * - only entries under this plugin's own prefixes are candidates, and only
 *   directories owned by the same uid asking;
 * - the directory name carries the process id that made it, so a generation that
 *   is still running is recognised and left alone — no age threshold needed;
 * - names from before the id was recorded are judged by age alone, and the two
 *   things that could go wrong if that judgement is unlucky are covered rather
 *   than hoped away: a socket directory whose master is still listening is never
 *   touched (the live socket answers a connect), and an askpass helper that gets
 *   collected from under a running Host is rebuilt by that Host on its next use;
 * - anything else in `/tmp` is somebody else's, however similar its name looks.
 *
 * Spill files — the full-output recovery files the subprocess provider writes
 * when a stream passes its ceiling — are deliberately **not** collected here.
 * They are not this plugin's files: the provider creates them in its own
 * per-process directory, closes them when the child settles, and keeps completed
 * ones until something outside the process cleans them. A consumer that unlinked
 * one would leave the path still being quoted by the provider's own readers, and
 * a plugin is a consumer. What this module does instead is count the spill this
 * plugin *asked for*, so the asking can stop when the machine has had enough.
 *
 * @module @jie2gg/dsh-plugin-ssh/tmpgc
 */

import { createConnection } from 'node:net'
import { readdir, lstat, rm, utimes } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The directory prefix the askpass helper lives under, one per activation. */
export const ASKPASS_DIRECTORY = 'dsh-ssh-askpass-'

/** The directory prefix the control sockets live under, one per activation. */
export const MUX_DIRECTORY = 'dsh-ssh-mux-'

/** The helper file inside an askpass directory, whose timestamps say who used it last. */
export const ASKPASS_SCRIPT = 'askpass.sh'

/** The directory prefixes this plugin creates in the system temp directory. */
export const TEMP_PREFIXES = [ASKPASS_DIRECTORY, MUX_DIRECTORY] as const

/**
 * How long a name from before process ids were recorded has to have gone untouched
 * before it is taken as residue.
 *
 * Three days, and deliberately far longer than any ordinary restart gap, because
 * a legacy name says nothing about who is using it. The sweep measured that on a
 * live machine: a Host that had been running for thirteen hours had its helper
 * collected by a newer generation's sweep under the shorter window, and a build
 * that predates the rebuild-on-use below cannot recover from that without a
 * restart. A pid in the name is proof; the absence of one is only a guess, so it
 * waits three days.
 */
export const LEGACY_STALE_MS = 3 * 24 * 60 * 60 * 1000

/** What one candidate directory turned out to be. */
export type StaleVerdict =
  | { keep: true; reason: 'alive' | 'young' | 'not-owned' | 'not-a-directory' | 'ours' | 'unreadable' | 'live-socket' | 'in-use' }
  | { keep: false; reason: 'dead-pid' | 'legacy-age' }

/** One entry the sweep looked at. */
export interface TempEntry {
  /** Absolute path of the directory. */
  path: string
  /** The prefix it matched, so a caller can name it in a log line. */
  prefix: string
  /** The process id the name carries, when it carries one. */
  pid: number | undefined
  /** Milliseconds since the directory was last touched. */
  ageMs: number
  /** What the sweep decided, and why. */
  verdict: StaleVerdict
}

/** What one sweep did. */
export interface SweepResult {
  /** Directories that matched the namespace and were looked at. */
  scanned: number
  /** Removed, with the reason they were collectable. */
  removed: TempEntry[]
  /** Left alone, with the reason they were not. */
  kept: TempEntry[]
  /** Paths whose state could not be read, or whose removal failed. */
  errors: { path: string; message: string }[]
}

/**
 * Read the process id out of a directory name this plugin made.
 * @param name - the basename, e.g. `dsh-ssh-mux-p4242-Q7dKz3`.
 * @param prefix - the prefix it matched.
 * @returns the id, or `undefined` for a name from before ids were recorded.
 */
export function pidOf (name: string, prefix: string): number | undefined {
  const rest = name.slice(prefix.length)
  const match = /^p(\d+)-/u.exec(rest)
  if (match === null) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Whether one process id still names a running process this process may judge.
 *
 * `ESRCH` is the answer that means gone. `EPERM` means a process with that id
 * exists and belongs to somebody else, which is also "do not touch": the
 * namespace is per-uid, and a stranger's pid is not evidence about ours.
 * @param pid - the id a directory name carries.
 * @param alive - the liveness probe, injectable so a test does not have to
 *   resurrect its own process id.
 * @returns true when the id must be treated as running.
 */
export function pidAlive (pid: number, alive: (id: number) => boolean = defaultAlive): boolean {
  return alive(pid)
}

/** The default liveness probe: signal 0, which asks without disturbing. */
function defaultAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
    // EPERM is a live process owned by someone else; only "no such process" is a
    // collection licence.
    return code !== 'ESRCH'
  }
}

/**
 * Whether one control socket is still answering, which is how a live master is
 * recognised without owning it.
 *
 * A master that is up has the socket bound; connecting succeeds and is closed
 * again at once. A socket left behind by a dead master answers nothing, and an
 * `ssh` client that later names that path would fall back to dialing its own
 * connection anyway — so a directory holding a socket nobody is listening on is
 * residue, and one holding a socket that answers is not.
 * @param socketPath - the path to try.
 * @param timeoutMs - how long a connect may take before it counts as dead.
 * @returns true when something is listening.
 */
export function socketLive (socketPath: string, timeoutMs = 150): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ path: socketPath })
    const finish = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

/**
 * The helper paths that some running process of this account says it is using.
 *
 * A legacy name carries no process id, so age is the only thing the name itself
 * can answer — and age is a guess about a file that a Host may be using every day.
 * `/proc/<pid>/environ` is not a guess: the Host that prepared a helper passes that
 * helper's path to every child that needs a secret, so the path is sitting in the
 * environment of the process using it. Reading it for the processes this account
 * owns turns "three days idle" into "nobody running claims it", which is the
 * question the sweep actually cares about.
 *
 * On a machine without `/proc` this returns an empty set, and the age rule stands
 * on its own — a weaker answer, stated rather than hidden.
 * @returns the `SSH_ASKPASS` paths named by live processes of this uid.
 */
export function claimedHelpers (): Set<string> {
  const paths = new Set<string>()
  let pids: string[]
  try {
    pids = readdirSync('/proc')
  } catch {
    return paths
  }
  for (const name of pids) {
    if (!/^\d+$/u.test(name)) continue
    try {
      const raw = readFileSync(join('/proc', name, 'environ'))
      for (const entry of raw.toString('utf8').split('\0')) {
        if (!entry.startsWith('SSH_ASKPASS=')) continue
        const value = entry.slice('SSH_ASKPASS='.length)
        if (value !== '') paths.add(value)
      }
    } catch {
      // Gone, unreadable, or another account's: none of them is evidence either
      // way, and a sweep that stops at the first EACCES would collect nothing.
      continue
    }
  }
  return paths
}

/**
 * Classify one candidate directory.
 * @param path - the absolute candidate.
 * @param prefix - the namespace prefix it matched.
 * @param probe - what the sweep knows: this process's uid, its own directories,
 *   the clock, and the liveness tests.
 * @returns the entry with its verdict.
 */
export async function classify (
  path: string,
  prefix: string,
  probe: {
    uid: number
    now: number
    self: ReadonlySet<string>
    alive?: ((pid: number) => boolean) | undefined
    socketIsLive?: ((socketPath: string) => Promise<boolean>) | undefined
    /** The helper paths live processes claim; defaults to the `/proc` scan. */
    claims?: ReadonlySet<string> | undefined
  },
): Promise<TempEntry> {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const pid = pidOf(base, prefix)
  let stated: Awaited<ReturnType<typeof lstat>>
  try {
    stated = await lstat(path)
  } catch {
    return { path, prefix, pid, ageMs: 0, verdict: { keep: true, reason: 'unreadable' } }
  }
  if (!stated.isDirectory()) {
    return { path, prefix, pid, ageMs: 0, verdict: { keep: true, reason: 'not-a-directory' } }
  }
  // The owner has to be the account doing the collecting: `/tmp` is one namespace
  // shared by every user on the machine, and a directory that merely *looks* like
  // ours belongs to somebody else's process table.
  if (stated.uid !== probe.uid) {
    return { path, prefix, pid, ageMs: 0, verdict: { keep: true, reason: 'not-owned' } }
  }
  const ageMs = Math.max(0, probe.now - stated.mtimeMs)
  if (probe.self.has(path)) {
    return { path, prefix, pid, ageMs, verdict: { keep: true, reason: 'ours' } }
  }
  if (pid !== undefined && pidAlive(pid, probe.alive)) {
    return { path, prefix, pid, ageMs, verdict: { keep: true, reason: 'alive' } }
  }
  // A socket directory whose master is still listening is a running connection
  // owned by somebody's process, however old the directory looks.
  if (prefix === MUX_DIRECTORY) {
    const live = probe.socketIsLive ?? socketLive
    let names: string[] = []
    try {
      names = await readdir(path)
    } catch {
      names = []
    }
    for (const entry of names) {
      if (!entry.endsWith('.sock')) continue
      if (await live(join(path, entry))) {
        return { path, prefix, pid, ageMs, verdict: { keep: true, reason: 'live-socket' } }
      }
    }
  }
  if (pid !== undefined) {
    return { path, prefix, pid, ageMs, verdict: { keep: false, reason: 'dead-pid' } }
  }
  // A legacy askpass name has no id to argue with, so the directory's own
  // timestamp is only half the story: what the account is doing with the helper
  // shows up on the helper. The script's access and change times, the directory's,
  // and any live process that names the path in its environment are all evidence
  // of use, and the freshest of them is the one the idle rule reads.
  if (prefix === ASKPASS_DIRECTORY) {
    const helper = join(path, ASKPASS_SCRIPT)
    if ((probe.claims ?? claimedHelpers()).has(helper)) {
      return { path, prefix, pid, ageMs: 0, verdict: { keep: true, reason: 'in-use' } }
    }
    try {
      const script = await lstat(helper)
      const lastUsed = Math.max(stated.mtimeMs, script.mtimeMs, script.atimeMs)
      const idleMs = Math.max(0, probe.now - lastUsed)
      if (idleMs < LEGACY_STALE_MS) {
        return { path, prefix, pid, ageMs: idleMs, verdict: { keep: true, reason: 'young' } }
      }
      return { path, prefix, pid, ageMs: idleMs, verdict: { keep: false, reason: 'legacy-age' } }
    } catch {
      // No helper inside: nothing is using it, and the directory age decided above.
    }
  }
  if (ageMs < LEGACY_STALE_MS) {
    return { path, prefix, pid, ageMs, verdict: { keep: true, reason: 'young' } }
  }
  return { path, prefix, pid, ageMs, verdict: { keep: false, reason: 'legacy-age' } }
}

/**
 * Walk one temp directory and collect this plugin's residue.
 * @param options - the directory to walk (the system temp directory by default),
 *   the uid to accept, the clock, this process's own live directories, and the
 *   two injectable liveness probes.
 * @returns what was scanned, removed, kept, and could not be read.
 */
export async function sweep (options: {
  /** The directory to walk — the system temp directory at runtime. */
  root: string
  /** The uid whose residue may be collected. */
  uid: number
  now?: number
  self?: Iterable<string>
  alive?: (pid: number) => boolean
  socketIsLive?: (socketPath: string) => Promise<boolean>
  /** The helper paths live processes claim; computed once when not supplied. */
  claims?: ReadonlySet<string>
  remove?: (path: string) => Promise<void>
}): Promise<SweepResult> {
  const root = options.root
  const uid = options.uid
  const now = options.now ?? Date.now()
  const self = new Set(options.self ?? [])
  const claims = options.claims ?? claimedHelpers()
  const result: SweepResult = { scanned: 0, removed: [], kept: [], errors: [] }
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error: unknown) {
    result.errors.push({ path: root, message: error instanceof Error ? error.message : String(error) })
    return result
  }
  for (const name of names) {
    const prefix = TEMP_PREFIXES.find(entry => name.startsWith(entry))
    if (prefix === undefined) continue
    const path = join(root, name)
    result.scanned += 1
    const entry = await classify(path, prefix, { uid, now, self, alive: options.alive, socketIsLive: options.socketIsLive, claims })
    if (entry.verdict.keep) {
      result.kept.push(entry)
      continue
    }
    try {
      // A directory this process did not make is removed without recursion
      // guards: the namespace is ours, the owner check already passed, and the
      // only thing a generation leaves inside these is its own helper or socket.
      await (options.remove ?? ((target: string) => rm(target, { recursive: true, force: true })))(path)
      result.removed.push(entry)
    } catch (error: unknown) {
      result.errors.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * Backdate one directory's mtime, so a test can be a day old without waiting.
 * @param path - the directory to age.
 * @param ageMs - how much older than now it should claim to be.
 * @returns resolution once the timestamps are set.
 */
export async function age (path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}
