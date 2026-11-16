/**
 * Typed access to the plugin's own storage domain.
 *
 * The domain is authoritative data, so every write goes through a schema here
 * before the record reaches the backend, and every read is re-parsed so a
 * hand-edited JSON file cannot smuggle a malformed record into the page.
 *
 * @module @jie2gg/dsh-plugin-ssh/store
 */

import { randomBytes } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { connectionRecordSchema, MAX_ALLOWED_COMMANDS, MAX_CONNECTIONS, settingsRecordSchema, sshTargetsDomain } from './storage.ts'
import { SshError } from './types.ts'
import type { ConnectionInput, ConnectionRecord, ProbeOutcome, SessionTarget, SshSettings } from './types.ts'

/** The opened domain this store wraps. */
type SshTargetsDomain = Domain<typeof sshTargetsDomain>

/**
 * Assign one target identity: `ssh-` plus ten lowercase hexadecimal digits,
 * the shape {@link connectionRecordSchema} accepts.
 * @returns a fresh id.
 */
function newId(): string {
  return `ssh-${randomBytes(5).toString('hex')}`
}

/**
 * Keep only the fields the page owns, dropping the empty ones so a stored
 * record carries no key for an unset option.
 * @param input - a validated target as the page submitted it.
 * @returns the identity fields of a {@link ConnectionRecord}.
 */
function identityOf(input: ConnectionInput): Omit<ConnectionRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const trimmed = (value: string | undefined): string | undefined => {
    const next = value?.trim()
    return next === undefined || next === '' ? undefined : next
  }
  const args = input.extraArgs === undefined || input.extraArgs.length === 0 ? undefined : [...input.extraArgs]
  const user = trimmed(input.user)
  const identityFile = trimmed(input.identityFile)
  const proxyJump = trimmed(input.proxyJump)
  const note = trimmed(input.note)
  return {
    label: trimmed(input.label) ?? '',
    host: trimmed(input.host) ?? '',
    auth: input.auth ?? 'key',
    agentAccess: input.agentAccess ?? 'on',
    pool: input.pool ?? 'on',
    allowedCommands: [...(input.allowedCommands ?? [])].slice(0, MAX_ALLOWED_COMMANDS),
    ...(input.remoteTimeoutMs === undefined || input.remoteTimeoutMs === null ? {} : { remoteTimeoutMs: input.remoteTimeoutMs }),
    ...(input.maxOutputBytes === undefined || input.maxOutputBytes === null ? {} : { maxOutputBytes: input.maxOutputBytes }),
    ...(user === undefined ? {} : { user }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    ...(args === undefined ? {} : { extraArgs: args }),
    ...(note === undefined ? {} : { note }),
  }
}

/** Durable target list and shared settings, read and written through one domain. */
export class TargetStore {
  readonly #domain: SshTargetsDomain

  /**
   * @param domain - the opened {@link sshTargetsDomain} this store owns.
   */
  constructor(domain: SshTargetsDomain) {
    this.#domain = domain
  }

  /** The connections table handle. */
  #table() {
    return this.#domain.table('connections')
  }

  /**
   * Every stored target, ordered by label so the list is stable across reloads.
   * @returns the validated records.
   */
  list(): ConnectionRecord[] {
    const records: ConnectionRecord[] = []
    for (const [, record] of this.#table().entries()) {
      try {
        records.push(connectionRecordSchema.parse(record))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        throw new SshError('storage-error', 'A stored SSH target does not match the saved format.', {
          hint: message.slice(0, 512),
        })
      }
    }
    return records.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
  }

  /**
   * One stored target.
   * @param id - the record key.
   * @returns the record, or `undefined` when it is absent.
   */
  get(id: string): ConnectionRecord | undefined {
    const record = this.#table().get(id)
    if (record === undefined) return undefined
    try {
      return connectionRecordSchema.parse(record)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new SshError('storage-error', 'A stored SSH target does not match the saved format.', {
        hint: message.slice(0, 512),
        field: 'id',
      })
    }
  }

  /** How many targets are stored. */
  get size(): number {
    return this.#table().size
  }

  /** The shared settings, with the schema defaults applied. */
  settings(): SshSettings {
    return this.#domain.global.get()
  }

  /**
   * Replace the shared settings.
   * @param next - the settings to persist.
   * @returns the persisted settings.
   */
  async saveSettings(next: SshSettings): Promise<SshSettings> {
    const value = settingsRecordSchema.parse(next)
    await this.#domain.global.set(value)
    return value
  }

  /**
   * Insert one new target.
   * @param input - the validated identity fields, without an id.
   * @returns the stored record.
   */
  async create(input: ConnectionInput): Promise<ConnectionRecord> {
    if (this.size >= MAX_CONNECTIONS) {
      throw new SshError('bad-input', `This plugin stores at most ${String(MAX_CONNECTIONS)} SSH targets.`, {
        field: 'connections',
        hint: 'Remove a connection and try again.',
      })
    }
    const now = new Date().toISOString()
    const record = connectionRecordSchema.parse({ ...identityOf(input), id: newId(), createdAt: now, updatedAt: now })
    await this.#table().put(record.id, record)
    return record
  }

  /**
   * Overwrite one existing target, keeping its identity and creation time.
   * @param id - the record key.
   * @param input - the validated identity fields.
   * @returns the stored record.
   */
  async edit(id: string, input: ConnectionInput): Promise<ConnectionRecord> {
    const current = this.get(id)
    if (current === undefined) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
    const record = connectionRecordSchema.parse({
      ...identityOf(input),
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      ...(current.lastProbe === undefined ? {} : { lastProbe: current.lastProbe }),
    })
    await this.#table().put(id, record)
    return record
  }

  /**
   * Attach the latest probe to one record without touching its edit time.
   * @param id - the record key.
   * @param outcome - the probe to store.
   * @returns the updated record, or `undefined` when the target was removed meanwhile.
   */
  async recordProbe(id: string, outcome: ProbeOutcome): Promise<ConnectionRecord | undefined> {
    if (this.get(id) === undefined) return undefined
    await this.#table().update(id, current => {
      const next = { ...current, lastProbe: outcome }
      return connectionRecordSchema.parse(next) as typeof current
    })
    return this.get(id)
  }

  /**
   * Remove one target.
   * @param id - the record key.
   * @returns `true` when a record was deleted, `false` when it was already gone.
   */
  async remove(id: string): Promise<boolean> {
    return await this.#table().delete(id)
  }

  /** The conversation-target table handle. */
  #sessions() {
    return this.#domain.table('sessions')
  }

  /**
   * Point one conversation at a target.
   * @param sessionId - the DSH Session id.
   * @param targetId - the chosen target, which must exist.
   * @returns the stored row.
   */
  async setSessionTarget(sessionId: string, targetId: string): Promise<SessionTarget> {
    if (this.get(targetId) === undefined) {
      throw new SshError('not-found', `No stored SSH target carries the id "${targetId}".`, { field: 'targetId' })
    }
    const row: SessionTarget = { sessionId, targetId, setAt: new Date().toISOString() }
    await this.#sessions().put(sessionId, row)
    return row
  }

  /**
   * The target one conversation chose, if any.
   * @param sessionId - the DSH Session id.
   * @returns the stored row, or `undefined` when the conversation has none.
   */
  getSessionTarget(sessionId: string): SessionTarget | undefined {
    return this.#sessions().get(sessionId)
  }

  /**
   * Every conversation choice, for the page's picker.
   * @returns the stored rows.
   */
  listSessionTargets(): SessionTarget[] {
    return Array.from(this.#sessions().entries(), ([, row]) => row)
  }

  /**
   * Forget one conversation's choice.
   * @param sessionId - the DSH Session id.
   * @returns `true` when a row was removed.
   */
  async clearSessionTarget(sessionId: string): Promise<boolean> {
    return await this.#sessions().delete(sessionId)
  }

  /**
   * Forget every conversation choice pointing at one target, so a deleted target
   * cannot leave a dangling id behind.
   * @param targetId - the removed target.
   * @returns how many conversations were cleared.
   */
  async forgetSessionTargetsFor(targetId: string): Promise<number> {
    const stale = Array.from(this.#sessions().keys()).filter(sessionId => this.#sessions().get(sessionId)?.targetId === targetId)
    if (stale.length === 0) return 0
    await this.#sessions().deleteMany(stale)
    return stale.length
  }

  /**
   * Release the domain, draining queued writes first.
   * @returns resolution once the backend unit is free.
   */
  async close(): Promise<void> {
    await this.#domain.close()
  }
}
