/**
 * The one rule a transfer's local side obeys: it stays inside the conversation's
 * own workspace.
 *
 * A remote server is already an authority boundary the user chose; the local
 * boundary is the session workspace, and a model-supplied path must not be able
 * to read or overwrite arbitrary files outside it. The check is lexical on
 * purpose: the file is moved by `scp`, not by this process, so there is no
 * provider call to fold a realpath through before the copy starts.
 *
 * @module @jie2gg/dsh-plugin-ssh/local-path
 */

import { SshError } from './types.ts'

/**
 * Resolve one local path against the conversation workspace.
 * @param raw - the path as sent, absolute or workspace-relative.
 * @param dir - the conversation workspace directory.
 * @returns the absolute local path.
 * @throws a `bad-input` {@link SshError} naming `localPath` when it escapes.
 */
export function resolveLocalInside(raw: string, dir: string): string {
  const value = (raw ?? '').trim()
  if (value === '') throw new SshError('bad-input', 'A local path is required.', { field: 'localPath' })
  if (/[\0\n\r]/u.test(value)) throw new SshError('bad-input', 'A local path cannot contain a line break.', { field: 'localPath' })
  const root = dir.replace(/\/+$/u, '')
  if (root === '') throw new SshError('internal', 'The conversation workspace directory is unknown.', { field: 'localPath' })
  const joined = value.startsWith('/') ? value : `${root}/${value.replace(/^\/+/u, '')}`
  const segments = joined.split('/')
  if (segments.includes('..')) {
    throw new SshError('bad-input', `"${value}" walks out of the conversation workspace.`, { field: 'localPath' })
  }
  if (joined !== root && !joined.startsWith(`${root}/`)) {
    throw new SshError('bad-input', `"${value}" is outside the conversation workspace ${root}.`, {
      field: 'localPath',
      hint: 'Give a path inside the workspace, or one relative to it.',
    })
  }
  return joined
}
