/**
 * The helper `ssh` calls when it needs a password or a key passphrase and has
 * no terminal to ask on.
 *
 * The plugin spawns `ssh` with stdin ignored, so an interactive prompt would
 * hang until the probe timed out. Setting `SSH_ASKPASS` to a program the Harness
 * owns, together with `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4 and later), is how
 * the secret reaches the client: the helper answers from a per-probe environment
 * variable and never appears on a command line, where a sibling process could
 * read it from the process list.
 *
 * The file lives in a private temporary directory this plugin creates at
 * activation and removes on unload; the secret itself is handed to each child
 * explicitly, which also carries it past the environment scrub that strips
 * credential-shaped and `DSH_*` names from every spawned process.
 *
 * @module @jie2gg/dsh-plugin-ssh/askpass
 */

import { accessSync, chmodSync, constants, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASKPASS_DIRECTORY, ASKPASS_SCRIPT } from './tmpgc.ts'



/**
 * The directory prefix, with this process's id in it.
 *
 * The id is not decoration: it is what tells a later generation's cleanup that
 * this directory belongs to a process still running, rather than to one that was
 * killed before its disposer could run. Names from before the id was recorded are
 * still collected, just on the slower evidence of age and absence.
 */
export function askPassPrefix (): string {
  return `${ASKPASS_DIRECTORY}p${process.pid.toString()}-`
}

/**
 * The helper itself. `ssh` passes the prompt text as its first argument, so the
 * script answers a passphrase prompt with the passphrase and anything else with
 * the password — and **only** with that slot. The two never fall back into each
 * other: a wrong login password against a key-only server once answered a
 * passphrase prompt, spent the one allowed prompt attempt, and left the real
 * failure reading as `permission denied (publickey)` for a secret nobody was
 * being asked about. An empty answer to a prompt whose slot is empty fails that
 * authentication method honestly, which is what the hint text then explains.
 */
const SCRIPT = [
  '#!/bin/sh',
  '# Written by @jie2gg/dsh-plugin-ssh for one plugin activation.',
  'case "$1" in',
  '  *[Pp]assphrase*)',
  '    answer=$DSH_SSH_ASKPASS_PASSPHRASE',
  '    ;;',
  '  *)',
  '    answer=$DSH_SSH_ASKPASS_PASSWORD',
  '    ;;',
  'esac',
  'printf \'%s\\n\' "$answer"',
  '',
].join('\n')

/**
 * Owns the private directory and the helper script for one activation.
 *
 * It structurally satisfies the transport's `AskPassSource` — one contract,
 * declared where it is consumed; the duplicate face this class used to
 * implement added a name without adding a check.
 */
/** How often using the helper is allowed to rewrite a timestamp, in milliseconds. */
const HEARTBEAT_MS = 60_000

export class AskPassHelper {
  #directory: string | undefined
  #script: string | undefined
  #failure: string | undefined
  #beat = 0

  /**
   * The helper's path, rebuilt first if the file is no longer there.
   *
   * The transport reads this synchronously while it is assembling a child, and
   * the file can disappear between the activation that made it and the call that
   * needs it: a newer Host generation sweeps the temp namespace by pid and age,
   * and a long-running Host's helper is exactly the kind of old, untouched file
   * such a sweep is allowed to take. Rebuilding it here, under the same name, is
   * what makes that sweep safe to run at all — the alternative is a password
   * prompt that fails with a message about a helper nobody removed.
   * @returns the helper path, or `undefined` when it never could be made.
   */
  get path(): string | undefined {
    const script = this.#script
    if (script === undefined) return undefined
    if (this.#exists(script)) {
      this.#heartbeat()
      return script
    }
    this.#rebuild()
    return this.#script
  }

  /** The private directory this activation owns, while it has one. */
  get directory(): string | undefined {
    return this.#directory
  }

  /** Why preparation failed, ready for a hint line. */
  get failure(): string | undefined {
    return this.#failure
  }

  /** Whether a probe can use a stored secret on this Host. */
  get ready(): boolean {
    return this.path !== undefined
  }

  /**
   * Mark the directory as used, at most once a minute.
   *
   * The sweep is allowed to take a legacy-named directory that has sat untouched
   * for three days, and a long-running Host's helper is exactly the thing that can
   * look untouched while being anything but. Renewing the timestamp when a call
   * actually uses the helper is what makes that judgement about *idleness* rather
   * than about *age* — the rate limit is there so a busy conversation does not
   * spend a syscall per command.
   */
  #heartbeat(): void {
    const directory = this.#directory
    if (directory === undefined) return
    const now = Date.now()
    if (now - this.#beat < HEARTBEAT_MS) return
    this.#beat = now
    try {
      const when = new Date()
      utimesSync(directory, when, when)
      // The script too: the sweep reads the idle of the helper, not of the parent,
      // and on a filesystem with lazy access times the directory alone can look
      // older than the process that has been execing through it all afternoon.
      utimesSync(join(directory, ASKPASS_SCRIPT), when, when)
    } catch {
      // A timestamp this process cannot renew is a sweep that may yet take the
      // directory, and the read above rebuilds it. Nothing here is worth failing a
      // password prompt for.
    }
  }

  /** Whether the helper file is where this activation left it. */
  #exists(script: string): boolean {
    try {
      accessSync(script, constants.R_OK | constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  /**
   * Put the helper back after something outside this process took it away.
   *
   * Synchronous and small on purpose: one directory and one 230-byte script, done
   * in the path getter the transport is already standing in.
   */
  #rebuild(): void {
    const directory = this.#directory
    if (directory === undefined) return
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const script = join(directory, ASKPASS_SCRIPT)
      writeFileSync(script, SCRIPT, { mode: 0o700 })
      chmodSync(script, 0o700)
      this.#script = script
      this.#failure = undefined
    } catch (error: unknown) {
      this.#failure = error instanceof Error ? error.message : String(error)
      this.#script = undefined
    }
  }

  /**
   * Materialize the helper, idempotently.
   * @returns the helper path, or `undefined` when the write failed.
   */
  async prepare(): Promise<string | undefined> {
    if (this.#script !== undefined) return this.#script
    try {
      const directory = await mkdtemp(join(tmpdir(), askPassPrefix()))
      await chmod(directory, 0o700)
      const script = join(directory, ASKPASS_SCRIPT)
      await writeFile(script, SCRIPT, { mode: 0o700 })
      await chmod(script, 0o700)
      this.#directory = directory
      this.#script = script
      this.#failure = undefined
      return script
    } catch (error: unknown) {
      this.#failure = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  /**
   * Remove the private directory and everything in it.
   * @returns resolution once the tree is gone; a cleanup failure is swallowed.
   */
  async dispose(): Promise<void> {
    const directory = this.#directory
    this.#directory = undefined
    this.#script = undefined
    if (directory === undefined) return
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
