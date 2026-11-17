/**
 * The per-target connection pool.
 *
 * Before this module every remote operation was its own `ssh`: dial, key-exchange,
 * authenticate, run, hang up. Four of those at a time was the whole plugin's
 * ceiling, so four backgrounded commands locked the settings page out of its own
 * test button, and a conversation that touched three servers opened three fresh
 * sessions on each of them.
 *
 * OpenSSH already knows how to share one authenticated connection: the first client
 * to arrive for a `ControlPath` becomes the master, and every later client for that
 * same path multiplexes over it — no second handshake, no second authentication, and
 * one `sshd` at the far end instead of one per call. This module owns the
 * bookkeeping around that mechanism and nothing else:
 *
 * - one private directory per activation (`mkdtemp` plus `0o700`), the shape the
 *   askpass helper already uses, because a control socket must not live where
 *   another user could point a client at it;
 * - one socket name per target *and* per the fields that decide the connection,
 *   including the credential, so editing a target leaves the old master to its own
 *   idle timeout instead of being reused under changed settings;
 * - a ceiling on how many masters are alive at once, retiring the least-recently-used
 *   idle one before opening another;
 * - no liveness probe on the hot path: `ControlMaster=auto` falls back to a fresh
 *   direct connection when the master is gone, which is the self-healing route, and
 *   asking `ssh -O check` first would spend a process on every call.
 *
 * The pool therefore keeps a *belief* about which masters are alive, and every
 * judgment it makes is one OpenSSH can survive being wrong about. It never holds a
 * connection itself, and a call it refuses to pool still runs — sharing is an
 * optimisation, never a dependency.
 *
 * @module @jie2gg/dsh-plugin-ssh/pool
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONTROL_PERSIST_SECONDS, MAX_LIVE_MASTERS } from './storage.ts'

/** Directory prefix inside the system temp directory, one per activation. */
const DIRECTORY_PREFIX = 'dsh-ssh-mux-'

/** Suffix on every control socket this pool names. */
const SOCKET_SUFFIX = '.sock'

/**
 * Longest control path worth handing to `ssh`. A Unix socket name is capped by
 * `sun_path` (108 bytes including the terminator), and OpenSSH truncates silently
 * past that, which would make two targets share one socket by accident. The pool
 * declines to pool instead of risking that.
 */
export const SOCKET_PATH_LIMIT = 100

/**
 * Flags that keep a call off the pool entirely. `ControlPath=none` is the only
 * value that disables sharing: `ControlMaster=no` on its own still joins a master
 * that is already listening, and the Host account's own `~/.ssh/config` may name a
 * `ControlPath` we know nothing about.
 */
export const NO_SHARE_FLAGS: readonly string[] = ['-o', 'ControlPath=none', '-o', 'ControlMaster=no']

/**
 * How often the expiry sweep may re-stat one idle past-persist master before
 * believing it gone. Long enough that a busy claim loop does not touch the
 * filesystem for the same socket, short enough that a master which just
 * expired is off the UI's count inside half a minute.
 */
const SWEEP_RECHECK_MS = 30_000

/**
 * The connection-deciding fields one call carries.
 *
 * Stated here rather than imported from the transport: a plugin resolves its own
 * copy of a package, and a nominal type across two copies does not satisfy the
 * compiler. The shape is structural, so a `RemoteTarget` fits it as it stands.
 */
export interface ShareableTarget {
  /** Host name or an existing OpenSSH host alias. */
  host: string
  /** Remote user. */
  user?: string | undefined
  /** Remote port. */
  port?: number | undefined
  /** Private key path. */
  identityFile?: string | undefined
  /** Jump host. */
  proxyJump?: string | undefined
  /** Additional client flags. */
  extraArgs?: readonly string[] | undefined
  /** The stored target's id; an unsaved draft has none and keys off its fields. */
  id?: string | undefined
  /** Whether this target is allowed to share its connection at all. */
  pool?: 'on' | 'off' | undefined
}

/** What one call authenticates with, as far as the pool needs it. */
export interface ShareableAuth {
  /** How the target authenticates. */
  mode?: string | undefined
  /** Login password, hashed into the key and never stored. */
  password?: string | undefined
  /** Private-key passphrase, hashed into the key and never stored. */
  passphrase?: string | undefined
}

/** The lease one call holds while it may be sharing a master. */
export interface PoolTicket {
  /** ssh flags for this call; {@link NO_SHARE_FLAGS} when it is not sharing. */
  readonly flags: readonly string[]
  /** Why this call is running on its own, when a reader should know. */
  readonly note: string | undefined
  /** Whether this call was handed one of this pool's sockets. */
  readonly pooled: boolean
  /** Hand back the in-use count. Always called, usually from a `finally`. */
  release(): void
  /** Record that this call's dial worked, so later calls may reuse the master. */
  markLive(): void
  /** Forget the master: it is dead, untrusted, or refusing another channel. */
  drop(): void
}

/** Ask OpenSSH to close one master. Best-effort, never awaited by the caller. */
export type MasterExiter = (socketPath: string, authority: string) => Promise<void>

/**
 * What the transport needs from a pool, stated so a test can hand the transport a
 * fake ledger instead of a real one with real sockets.
 */
export interface MuxSource {
  /** Whether a call may be pooled at all. */
  readonly ready: boolean
  /** Why pooling is unavailable, when it is. */
  readonly failure: string | undefined
  /** How many masters are open or being dialed right now. */
  readonly liveMasters: number
  /** Lease the shared connection one call wants. */
  claim(target: ShareableTarget, auth: ShareableAuth): PoolTicket
}

/** One master the pool believes exists, or is on its way up. */
interface MasterEntry {
  readonly socketPath: string
  readonly authority: string
  /** How many calls are multiplexing over it right now. */
  inFlight: number
  /** Whether a call has finished dialing through it. */
  alive: boolean
  /** Millisecond of the last claim or release, for the eviction order. */
  lastUsed: number
  /** Millisecond the expiry sweep last checked this master's socket. */
  lastChecked: number
}

/**
 * The `[user@]host` one `-O exit` needs alongside its control path.
 * @param target - the fields a call dials with.
 * @returns the authority argument.
 */
function authorityOf(target: ShareableTarget): string {
  return target.user === undefined || target.user === '' ? target.host : `${target.user}@${target.host}`
}

/**
 * A shared connection is only safe to share when everything that decides it matches.
 * The id carries the stored target, and these fields carry what a draft typed, plus
 * the credential itself: a probe run with a second password must not ride along on a
 * master that authenticated with the first one and report the wrong secret as good.
 * @param target - the fields a call dials with.
 * @param auth - the credential the call answers prompts with.
 * @returns the hex digest naming the socket.
 */
function fingerprintOf(target: ShareableTarget, auth: ShareableAuth): string {
  const hash = createHash('sha256')
  const parts = [
    authorityOf(target),
    target.port === undefined ? '' : String(target.port),
    target.proxyJump ?? '',
    target.identityFile ?? '',
    (target.extraArgs ?? []).join('\u0000'),
    auth.mode ?? 'key',
    auth.password === undefined ? '' : `pw:${auth.password}`,
    auth.passphrase === undefined ? '' : `pp:${auth.passphrase}`,
  ]
  return hash.update(parts.join('\u0001'), 'utf8').digest('hex').slice(0, 10)
}

/**
 * Owns the control sockets, the master ledger, and the ceiling on how many masters
 * are open at once.
 */
export class MuxPool implements MuxSource {
  #directory: string | undefined
  #failure: string | undefined
  readonly #masters = new Map<string, MasterEntry>()
  #exiter: MasterExiter = async () => undefined
  // The clock, injectable for one reason: the expiry below is a matter of
  // seconds, and no honest test wants to sleep through ControlPersist.
  readonly #now: () => number

  /**
   * @param now - the time source for master expiry; defaults to the wall clock.
   */
  constructor(now?: () => number) {
    this.#now = now ?? Date.now
  }

  /** Whether a call may be pooled at all. */
  get ready(): boolean {
    return this.#directory !== undefined
  }

  /** Why pooling is unavailable on this Host, ready for a hint line. */
  get failure(): string | undefined {
    return this.#failure
  }

  /**
   * How many masters the pool is holding open or still dialing.
   *
   * Reading this number sweeps first: `ControlPersist` lets OpenSSH close an
   * idle master and remove its socket long before this ledger notices, and a
   * reader of `liveMasters` — the settings card, the `list` payload — deserves
   * the count of what is alive, not of what was once believed.
   */
  get liveMasters(): number {
    this.sweep()
    return this.#masters.size
  }

  /**
   * Drop ledger entries whose master has expired with its socket gone.
   *
   * The rule is deliberate about what it does not claim: an entry idle past
   * `ControlPersist` is only retired when its socket file no longer exists —
   * the socket is what OpenSSH leaves behind while the master lives, so its
   * absence is the proof, and a longer persist policy somebody set elsewhere
   * keeps the master counted. A dial that has not proved itself yet is left to
   * its own release path, and in-flight entries are never touched.
   * @param now - the moment to measure idleness from; defaults to the clock.
   * @returns how many expired beliefs were dropped.
   */
  sweep(now: number = this.#now()): number {
    let dropped = 0
    for (const [socketPath, entry] of [...this.#masters]) {
      if (!entry.alive || entry.inFlight > 0) continue
      if (now - entry.lastUsed < CONTROL_PERSIST_SECONDS * 1000) continue
      if (now - entry.lastChecked < SWEEP_RECHECK_MS) continue
      if (existsSync(socketPath)) {
        // The master is still answering its socket past the nominal persist —
        // re-arm the check so the sweep does not stat the same path per call.
        entry.lastChecked = now
        continue
      }
      this.#masters.delete(socketPath)
      dropped += 1
    }
    return dropped
  }

  /** The private socket directory, while the pool is prepared. */
  get directory(): string | undefined {
    return this.#directory
  }

  /**
   * Give the pool the way to close a master it is evicting.
   * @param exiter - runs `ssh -O exit`; the pool calls it fire-and-forget.
   */
  attach(exiter: MasterExiter): void {
    this.#exiter = exiter
  }

  /**
   * Create the private socket directory, idempotently.
   * @returns the directory, or `undefined` when it could not be made.
   */
  async prepare(): Promise<string | undefined> {
    if (this.#directory !== undefined) return this.#directory
    try {
      const directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX))
      await chmod(directory, 0o700)
      this.#directory = directory
      this.#failure = undefined
      return directory
    } catch (error: unknown) {
      this.#failure = error instanceof Error ? error.message : String(error)
      this.#directory = undefined
      return undefined
    }
  }

  /**
   * The control socket one call would use, or `undefined` when it should not share.
   *
   * Naming a socket is not the same as leasing one: `ssh -G` asks the client to
   * print configuration and dials nothing, so it has no reason to claim a master.
   * @param target - the fields a call dials with.
   * @param auth - the credential the call answers prompts with.
   * @returns the absolute socket path, or `undefined`.
   */
  socketPathFor(target: ShareableTarget, auth: ShareableAuth): string | undefined {
    if (this.#directory === undefined || target.pool === 'off') return undefined
    const name = `${target.id ?? 'draft'}-${fingerprintOf(target, auth)}${SOCKET_SUFFIX}`
    const path = join(this.#directory, name)
    // A system temp directory with an unusual name can eat the whole socket budget.
    return path.length <= SOCKET_PATH_LIMIT ? path : undefined
  }

  /**
   * Lease the shared connection for one call.
   *
   * The returned flags belong to the call, and the ticket must be released when the
   * call is over; every path out of a pooled call ends in `release()`.
   * @param target - the fields a call dials with.
   * @param auth - the credential the call answers prompts with.
   * @returns the ticket, whose `flags` are either the three sharing options or
   *   {@link NO_SHARE_FLAGS}.
   */
  claim(target: ShareableTarget, auth: ShareableAuth): PoolTicket {
    const socketPath = this.socketPathFor(target, auth)
    if (socketPath === undefined) return inertTicket(this.#inertNote(target))
    // Expired beliefs get dropped before the ceiling is consulted: a ledger full
    // of masters ControlPersist already closed must not evict — with `-O exit` —
    // the one live master a ninth call is standing behind.
    this.sweep()
    if (this.#masters.size >= MAX_LIVE_MASTERS && !this.#masters.has(socketPath)) {
      const evictable = this.#leastUsedIdle()
      if (evictable === undefined) {
        // Every master is busy and the ledger is full: dial this one on its own
        // rather than opening an unplanned ninth session on some server.
        return inertTicket(`pool: ${String(MAX_LIVE_MASTERS)} masters already in use`)
      }
      this.#evict(evictable)
    }

    let entry = this.#masters.get(socketPath)
    if (entry === undefined) {
      entry = {
        socketPath,
        authority: authorityOf(target),
        inFlight: 0,
        alive: false,
        lastUsed: this.#now(),
        lastChecked: this.#now(),
      }
      this.#masters.set(socketPath, entry)
    }
    const leased = entry
    leased.inFlight += 1
    leased.lastUsed = this.#now()
    let released = false

    const ticket: PoolTicket = {
      flags: [
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${leased.socketPath}`,
        '-o', `ControlPersist=${String(CONTROL_PERSIST_SECONDS)}`,
      ],
      note: undefined,
      pooled: true,
      release: (): void => {
        if (released) return
        released = true
        leased.inFlight -= 1
        leased.lastUsed = this.#now()
        // A dial that never proved a master is worth keeping should not hold a slot.
        if (!leased.alive && leased.inFlight <= 0 && this.#masters.get(socketPath) === leased) {
          this.#masters.delete(socketPath)
        }
      },
      markLive: (): void => {
        leased.alive = true
        leased.lastUsed = this.#now()
      },
      drop: (): void => {
        if (this.#masters.get(socketPath) !== leased) return
        this.#masters.delete(socketPath)
        if (leased.alive) this.#evict(leased)
      },
    }
    return ticket
  }

  /**
   * Close every master the pool is holding and remove the socket directory.
   * @returns resolution once the exits were attempted and the directory is gone.
   */
  async dispose(): Promise<void> {
    const directory = this.#directory
    // A slot that never proved a master has no process behind it to thank.
    const proven = [...this.#masters.values()].filter(entry => entry.alive)
    this.#masters.clear()
    this.#directory = undefined
    await Promise.allSettled(proven.map(async entry => await this.#exiter(entry.socketPath, entry.authority)))
    if (directory === undefined) return
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * Why a call is running without the pool, in the words a reader of a result needs.
   * @param target - the fields a call dials with.
   * @returns the note, or `undefined` when the reader chose this themselves.
   */
  #inertNote(target: ShareableTarget): string | undefined {
    if (target.pool === 'off') return undefined
    if (this.#directory === undefined) {
      return this.#failure === undefined ? 'pool: not prepared yet' : `pool: ${this.#failure}`
    }
    return 'pool: this Host\u2019s temp path leaves no room for a socket name'
  }

  /**
   * Drop one master from the ledger and ask OpenSSH to close it.
   * @param entry - the master being retired.
   */
  #evict(entry: MasterEntry): void {
    if (this.#masters.get(entry.socketPath) === entry) this.#masters.delete(entry.socketPath)
    if (!entry.alive) return
    const exiting = this.#exiter(entry.socketPath, entry.authority)
    void exiting.catch(() => undefined)
  }

  /**
   * The master that has been idle longest, when one is idle.
   * @returns its ledger entry, or `undefined` when all are in use.
   */
  #leastUsedIdle(): MasterEntry | undefined {
    let oldest: MasterEntry | undefined
    for (const entry of this.#masters.values()) {
      if (entry.inFlight > 0) continue
      if (oldest === undefined || entry.lastUsed < oldest.lastUsed) oldest = entry
    }
    return oldest
  }
}

/**
 * The ticket one non-shared call carries, so callers have one code path.
 * @param note - why the call is running on its own connection.
 * @returns a ticket whose flags disable sharing and whose bookkeeping is a no-op.
 */
function inertTicket(note: string | undefined): PoolTicket {
  return {
    flags: NO_SHARE_FLAGS,
    note,
    pooled: false,
    release: () => undefined,
    markLive: () => undefined,
    drop: () => undefined,
  }
}
