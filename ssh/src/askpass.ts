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

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Script name inside the private directory. */
const SCRIPT_NAME = 'askpass.sh'

/**
 * The helper itself. `ssh` passes the prompt text as its first argument, so the
 * script answers a passphrase prompt with the passphrase and anything else with
 * the password, falling back to whichever slot is filled when only one was.
 */
const SCRIPT = [
  '#!/bin/sh',
  '# Written by @jie2gg/dsh-plugin-ssh for one plugin activation.',
  'case "$1" in',
  '  *[Pp]assphrase*)',
  '    answer=$DSH_SSH_ASKPASS_PASSPHRASE',
  '    if [ -z "$answer" ]; then answer=$DSH_SSH_ASKPASS_PASSWORD; fi',
  '    ;;',
  '  *)',
  '    answer=$DSH_SSH_ASKPASS_PASSWORD',
  '    if [ -z "$answer" ]; then answer=$DSH_SSH_ASKPASS_PASSPHRASE; fi',
  '    ;;',
  'esac',
  'printf \'%s\\n\' "$answer"',
  '',
].join('\n')

/** A ready askpass path, or the reason one is unavailable. */
export interface AskPassFace {
  /** Absolute path of the helper, once prepared. */
  readonly path: string | undefined
  /** Why preparation failed, when it did. */
  readonly failure: string | undefined
}

/** Owns the private directory and the helper script for one activation. */
export class AskPassHelper implements AskPassFace {
  #directory: string | undefined
  #script: string | undefined
  #failure: string | undefined

  /** Absolute path of the helper, or `undefined` while it is unavailable. */
  get path(): string | undefined {
    return this.#script
  }

  /** Why preparation failed, ready for a hint line. */
  get failure(): string | undefined {
    return this.#failure
  }

  /** Whether a probe can use a stored secret on this Host. */
  get ready(): boolean {
    return this.#script !== undefined
  }

  /**
   * Materialize the helper, idempotently.
   * @returns the helper path, or `undefined` when the write failed.
   */
  async prepare(): Promise<string | undefined> {
    if (this.#script !== undefined) return this.#script
    try {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-askpass-'))
      await chmod(directory, 0o700)
      const script = join(directory, SCRIPT_NAME)
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
