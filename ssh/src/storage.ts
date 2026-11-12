/**
 * The plugin's own durable storage domain.
 *
 * Nothing here touches the user's profile patch file: the connection list and
 * the global settings live in the storage domain the Host mounts, one JSON unit
 * per backend (`$DSH_HOME/storages/ssh_targets.json` on the `json` backend).
 * The domain rejects a record its schema does not accept, so the file stays
 * readable by hand and the page is the only ordinary writer.
 *
 * @module @jie2gg/dsh-plugin-ssh/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ConnectionRecord, SshSettings } from './types.ts'

/** Domain name, and the backend unit name it doubles as (`^[a-z][a-z0-9_]*$`). */
export const DOMAIN_NAME = 'ssh_targets'

/** Current record format version. */
export const DOMAIN_VERSION = 1

/** Ceiling on how many targets the page may keep. */
export const MAX_CONNECTIONS = 64

/** Ceiling on how many probes run at once. */
export const MAX_CONCURRENT_PROBES = 4

/** `ssh` executable used when the user changed nothing. */
export const DEFAULT_COMMAND = 'ssh'

/** Probe deadline bounds, in whole milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000
export const MIN_PROBE_TIMEOUT_MS = 1_000
export const MAX_PROBE_TIMEOUT_MS = 120_000

/** Per-stream capture bounds, in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536
export const MIN_MAX_OUTPUT_BYTES = 1_024
export const MAX_MAX_OUTPUT_BYTES = 4_194_304

/** Whole-millisecond UTC instant, the shape `new Date().toISOString()` writes. */
const instantSchema = z.iso.datetime({ precision: 3 })

/** Host-assigned target identity: `ssh-` plus ten lowercase hexadecimal digits. */
const idSchema = z.string().regex(/^ssh-[a-z0-9]{10}$/u)

/** A host name or an existing OpenSSH alias: no whitespace, no options marker. */
const hostSchema = z.string().trim().min(1).max(253).refine(
  value => !/\s/u.test(value) && !value.startsWith('-') && !value.includes('=') && !value.includes('~'),
  { message: 'Expected a host name or an OpenSSH host alias without whitespace' },
)

/** A POSIX path the OpenSSH client can open: absolute or `~/`-rooted. */
const pathSchema = z.string().trim().min(1).max(4096).refine(
  value => value.startsWith('/') || value.startsWith('~/'),
  { message: 'Expected an absolute path or a path starting with "~/"' },
)

/** One extra client flag; every entry is an option, never a positional host. */
const flagSchema = z.string().min(1).max(256).refine(
  value => value.startsWith('-') && !/[\0\n\r]/u.test(value),
  { message: 'Expected an ssh option flag starting with "-"' },
)

/** One classified probe result kept beside a target. */
export const probeOutcomeSchema = z.object({
  at: instantSchema,
  status: z.enum(['reachable', 'auth-failed', 'unreachable', 'unknown-host', 'timeout', 'ssh-missing', 'failed']),
  detail: z.string().min(1).max(2048).optional(),
  exitCode: z.number().int().min(-1).max(255).nullable().optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
}).strict()

/** One stored SSH target. */
export const connectionRecordSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(64),
  host: hostSchema,
  user: z.string().trim().min(1).max(128).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  identityFile: pathSchema.optional(),
  proxyJump: hostSchema.optional(),
  extraArgs: z.array(flagSchema).max(16).optional(),
  note: z.string().trim().min(1).max(512).optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  lastProbe: probeOutcomeSchema.optional(),
}).strict()

/** The domain's global slot: settings the whole page shares. */
export const settingsRecordSchema = z.object({
  command: z.string().trim().min(1).max(256).refine(
    value => value === DEFAULT_COMMAND || value.startsWith('/') || /^[a-z0-9._-]+$/u.test(value),
    { message: 'Expected "ssh", an absolute path, or a simple executable name' },
  ).default(DEFAULT_COMMAND),
  probeTimeoutMs: z.number().int().min(MIN_PROBE_TIMEOUT_MS).max(MAX_PROBE_TIMEOUT_MS).default(DEFAULT_PROBE_TIMEOUT_MS),
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
}).strict()

/** Initial settings served before the first write; never persisted as such. */
export const DEFAULT_SETTINGS: SshSettings = {
  command: DEFAULT_COMMAND,
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
}

/** What the page may send for one target: identity fields plus an optional id. */
export const connectionInputSchema = z.object({
  id: idSchema.optional(),
  label: z.string().trim().min(1).max(64),
  host: hostSchema,
  user: z.string().trim().min(1).max(128).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  identityFile: pathSchema.optional(),
  proxyJump: hostSchema.optional(),
  extraArgs: z.array(flagSchema).max(16).optional(),
  note: z.string().trim().min(1).max(512).optional(),
}).strict()

/** What the page may send for one unsaved draft target: no label, no id. */
export const probeDraftSchema = z.object({
  host: hostSchema,
  user: z.string().trim().min(1).max(128).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  identityFile: pathSchema.optional(),
  proxyJump: hostSchema.optional(),
  extraArgs: z.array(flagSchema).max(16).optional(),
}).strict()

/** What the page may send for the global settings; every field is optional. */
export const settingsInputSchema = z.object({
  command: z.string().trim().min(1).max(256).optional(),
  probeTimeoutMs: z.number().int().min(MIN_PROBE_TIMEOUT_MS).max(MAX_PROBE_TIMEOUT_MS).optional(),
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).optional(),
}).strict()

/** The one domain this plugin owns. */
export const sshTargetsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  global: { schema: settingsRecordSchema, initial: DEFAULT_SETTINGS },
  tables: { connections: domainTable<string, ConnectionRecord>(connectionRecordSchema) },
})
