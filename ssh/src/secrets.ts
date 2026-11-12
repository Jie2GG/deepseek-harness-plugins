/**
 * The password and passphrase a target authenticates with.
 *
 * These values never enter the storage domain and never reach the browser: they
 * live as `grant` records in the Harness credential store, addressed
 * `ssh/<target-id>-<kind>`, in the private file the credentials provider owns
 * (`$DSH_HOME/.credentials.yaml`, mode readable by the owner only). The list
 * reports presence through `describeRecord`, so a stored secret is displayed as
 * “set” and never as its value.
 *
 * @module @jie2gg/dsh-plugin-ssh/secrets
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { SshError } from './types.ts'
import type { SecretPatch, SecretStatus } from './types.ts'

/** One secret slot a target owns. */
export type SecretKind = 'password' | 'passphrase'

/** Both slots, in the order the page renders them. */
export const SECRET_KINDS: readonly SecretKind[] = ['password', 'passphrase']

/** The credential scope these records belong to: this plugin's name. */
const SCOPE = 'ssh'

/** What one stored grant record carries. */
interface StoredSecret {
  /** The secret itself. */
  secret: string
  /** When it was last written, as a canonical UTC instant. */
  savedAt: string
}

/** Reads and writes a target's secrets in the credential store. */
export class TargetSecrets {
  readonly #credentials: CredentialProvider

  /**
   * @param credentials - the Host credential provider (`ctx.credentials`).
   */
  constructor(credentials: CredentialProvider) {
    this.#credentials = credentials
  }

  /**
   * Address one target's secret slot.
   * @param id - the stored target id (`ssh-<hex>`, a valid key segment).
   * @param kind - which slot.
   * @returns the branded credential key.
   */
  keyFor(id: string, kind: SecretKind): CredentialKey {
    return credentialKey(SCOPE, `${id}-${kind}`)
  }

  /**
   * Whether each slot holds a secret, without reading one.
   * @param id - the stored target id.
   * @returns the presence flags.
   */
  async status(id: string): Promise<SecretStatus> {
    const seen: Record<SecretKind, boolean> = { password: false, passphrase: false }
    for (const kind of SECRET_KINDS) {
      try {
        const info = await this.#credentials.describeRecord(this.keyFor(id, kind))
        seen[kind] = info.configured
      } catch (error: unknown) {
        throw this.refused('read', error)
      }
    }
    return seen
  }

  /**
   * Read one secret value, for the probe that needs it.
   * @param id - the stored target id.
   * @param kind - which slot.
   * @returns the secret, or `undefined` when nothing is stored.
   */
  async read(id: string, kind: SecretKind): Promise<string | undefined> {
    let record: CredentialRecord | undefined
    try {
      record = await this.#credentials.readRecord(this.keyFor(id, kind))
    } catch (error: unknown) {
      throw this.refused('read', error)
    }
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload as Partial<StoredSecret> | undefined
    return typeof payload?.secret === 'string' && payload.secret !== '' ? payload.secret : undefined
  }

  /**
   * Apply one secret patch: a string writes, `null` forgets, absence is untouched.
   * @param id - the stored target id.
   * @param patch - what the page sent.
   * @returns resolution once every write landed.
   */
  async apply(id: string, patch: SecretPatch): Promise<void> {
    for (const kind of SECRET_KINDS) {
      const value = patch[kind]
      if (value === undefined) continue
      const key = this.keyFor(id, kind)
      try {
        if (value === null) {
          await this.#credentials.deleteRecord(key)
          continue
        }
        const record: CredentialRecord = { kind: 'grant', payload: { secret: value, savedAt: new Date().toISOString() } }
        await this.#credentials.modifyRecord(key, async () => record)
      } catch (error: unknown) {
        throw this.refused(value === null ? 'remove' : 'save', error)
      }
    }
  }

  /**
   * Forget every secret a target owns, used when the target is deleted.
   * @param id - the stored target id.
   * @returns resolution once both slots are cleared.
   */
  async clearAll(id: string): Promise<void> {
    await this.apply(id, { password: null, passphrase: null })
  }

  /**
   * Name a credential-store failure in the route's vocabulary.
   * @param action - what was attempted.
   * @param error - the provider's own error.
   * @returns the failure the page renders.
   */
  refused(action: string, error: unknown): SshError {
    const message = error instanceof Error ? error.message : String(error)
    return new SshError('secret-error', `The plugin could not ${action} its stored secret.`, {
      hint: message.slice(0, 512),
    })
  }
}
