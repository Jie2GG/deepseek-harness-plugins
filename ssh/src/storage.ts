/**
 * The plugin's own durable storage domain.
 *
 * Nothing here touches the user's profile patch file: the connection list, the
 * shared settings, and each conversation's chosen target live in the storage
 * domain the Host mounts, one JSON unit per backend (`$DSH_HOME/storages/
 * ssh_targets.json` on the `json` backend). The domain rejects a record its
 * schema does not accept, so the file stays readable by hand and the page stays
 * the only ordinary writer.
 *
 * Format history: 1 = targets only; 2 = added `auth`; 3 = added the agent-access
 * fields and the `sessions` table; 4 = the global slot shrank to the three
 * ceilings (the executable is detected now, and the probe deadline is fixed).
 * Older records keep opening because every added field is optional, and every
 * retired field is accepted and ignored, so no stored file is refused.
 *
 * @module @jie2gg/dsh-plugin-ssh/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ConnectionRecord, SessionTarget, SshSettings } from './types.ts'

/** Domain name, and the backend unit name it doubles as (`^[a-z][a-z0-9_]*$`). */
export const DOMAIN_NAME = 'ssh_targets'

/**
 * Current record format version. 2 added `auth`, 3 added the agent fields and
 * the `sessions` table, 4 shrank the global slot to the three ceilings the page
 * still edits — the executable is detected and the probe deadline is fixed.
 * The current schemas accept every earlier shape, so no stored file is
 * rewritten or refused on upgrade.
 */
export const DOMAIN_VERSION = 4

/** Older stored records the current schemas still accept. */
export const COMPATIBLE_VERSIONS = [1, 2, 3]

/** Ceiling on how many targets the page may keep. */
export const MAX_CONNECTIONS = 64

/** Ceiling on how many probes run at once. */
export const MAX_CONCURRENT_PROBES = 4

/** Ceiling on how many command names one target may allowlist. */
export const MAX_ALLOWED_COMMANDS = 32

/** Longest single allowlisted command name. */
export const MAX_COMMAND_LENGTH = 64

/**
 * The program one call dials with. Since 0.0.18 the page does not name it: the
 * transport tries this bare name on `PATH` first, then {@link SSH_FALLBACK_PATHS},
 * and remembers the first hit until the plugin unloads.
 */
export const SSH_EXECUTABLE = 'ssh'
export const SSH_FALLBACK_PATHS: readonly string[] = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/bin/ssh', '/opt/homebrew/bin/ssh']

/** The transfer sibling, searched the same way; a resolved ssh's own sibling wins. */
export const SCP_EXECUTABLE = 'scp'
export const SCP_FALLBACK_PATHS: readonly string[] = ['/usr/bin/scp', '/usr/local/bin/scp', '/bin/scp', '/opt/homebrew/bin/scp']

/**
 * The deadline one connectivity probe — and the download size pre-check —
 * waits to. Fixed in code since 0.0.18; 10 seconds was the default the page
 * used to offer, and it fit every recorded deployment without being raised.
 */
export const PROBE_TIMEOUT_MS = 10_000

/** How long one backgrounded remote command may run before it is called timed out. */
export const BACKGROUND_DEADLINE_MS = 1_800_000

/** Remote command deadline bounds, in whole milliseconds. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000
export const MIN_REMOTE_TIMEOUT_MS = 1_000
export const MAX_REMOTE_TIMEOUT_MS = 300_000

/** Per-stream capture bounds for probe and command output, in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536
export const MIN_MAX_OUTPUT_BYTES = 1_024
export const MAX_MAX_OUTPUT_BYTES = 4_194_304

/** File-transfer ceiling bounds, in bytes. */
export const DEFAULT_MAX_TRANSFER_BYTES = 33_554_432
export const MIN_MAX_TRANSFER_BYTES = 1_024
export const MAX_MAX_TRANSFER_BYTES = 536_870_912

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

/** One allowlisted program: a bare command name, no path, no arguments. */
const programSchema = z.string().trim().min(1).max(MAX_COMMAND_LENGTH).refine(
  value => /^[a-z0-9][a-z0-9._-]*$/u.test(value),
  { message: 'Expected a bare program name such as git, ls, or systemctl' },
)

/** How one target authenticates, including the mode 0.4.0 alone offered. */
export const authModeSchema = z.enum(['password', 'key', 'key+password'])

/** The modes a page may send: key, or password. */
export const authChoiceSchema = z.enum(['key', 'password'])

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
  auth: authModeSchema.default('key'),
  /** Whether the agent may reach this target at all; `off` hides it from tools. */
  agentAccess: z.enum(['on', 'off']).default('on'),
  /**
   * Program names the agent may run without asking. Empty means every remote
   * command needs an approval, which is what 0.6.0 ships as the safe default.
   */
  allowedCommands: z.array(programSchema).max(MAX_ALLOWED_COMMANDS).default([]),
  /** Per-target command deadline; absence follows the shared setting. */
  remoteTimeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).optional(),
  /** Per-target output ceiling; absence follows the shared setting. */
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).optional(),
}).strict()

/** The domain's global slot: the three ceilings the whole page shares. */
export const settingsRecordSchema = z.object({
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
  remoteTimeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).default(DEFAULT_REMOTE_TIMEOUT_MS),
  maxTransferBytes: z.number().int().min(MIN_MAX_TRANSFER_BYTES).max(MAX_MAX_TRANSFER_BYTES).default(DEFAULT_MAX_TRANSFER_BYTES),
  /**
   * The two fields a pre-0.0.18 page could edit. A stored slot written before
   * then still carries them; the strict schema accepts and ignores them, and
   * the next save drops them. Keeping them optional here is what lets an old
   * file keep opening rather than surfacing as a storage-error.
   */
  command: z.string().trim().min(1).max(256).optional(),
  probeTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict()

/** Initial settings served before the first write; not written as such. */
export const DEFAULT_SETTINGS: SshSettings = {
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  remoteTimeoutMs: DEFAULT_REMOTE_TIMEOUT_MS,
  maxTransferBytes: DEFAULT_MAX_TRANSFER_BYTES,
}

/** The conversation's chosen target, keyed by Session id. */
export const sessionTargetSchema = z.object({
  sessionId: z.string().min(1).max(256),
  targetId: idSchema,
  setAt: instantSchema,
}).strict()

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
  auth: authChoiceSchema.optional(),
  agentAccess: z.enum(['on', 'off']).optional(),
  allowedCommands: z.array(programSchema).max(MAX_ALLOWED_COMMANDS).optional(),
  remoteTimeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).nullable().optional(),
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).nullable().optional(),
}).strict()

/** What a `save` may write into the credential store. */
export const secretPatchSchema = z.object({
  password: z.string().min(1).max(4096).nullable().optional(),
  passphrase: z.string().min(1).max(4096).nullable().optional(),
}).strict()

/** What the page may send for one unsaved draft target: no label, no id. */
export const probeDraftSchema = z.object({
  host: hostSchema,
  user: z.string().trim().min(1).max(128).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  identityFile: pathSchema.optional(),
  proxyJump: hostSchema.optional(),
  extraArgs: z.array(flagSchema).max(16).optional(),
  auth: authChoiceSchema.optional(),
}).strict()

/** Secrets typed into an unsaved form: used for one probe, never stored. */
export const draftSecretSchema = z.object({
  password: z.string().min(1).max(4096).optional(),
  passphrase: z.string().min(1).max(4096).optional(),
}).strict()

/** What the page may send for the shared settings; every field is optional. */
export const settingsInputSchema = z.object({
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).optional(),
  remoteTimeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).optional(),
  maxTransferBytes: z.number().int().min(MIN_MAX_TRANSFER_BYTES).max(MAX_MAX_TRANSFER_BYTES).optional(),
}).strict()

/**
 * A path on the remote machine. Absolute or `~/`-rooted, and free of the shell
 * metacharacters this plugin would otherwise have to quote around: every path is
 * passed to the remote shell inside single quotes, and a metacharacter there is
 * more likely a typo than an intention.
 */
export const remotePathSchema = z.string().min(1).max(4096).refine(
  value => (value.startsWith('/') || value.startsWith('~/'))
    && !/[\n\r\0]/u.test(value)
    && !/[;|&<>()${}\\`]/u.test(value),
  { message: 'Expected an absolute remote path, or one starting with "~/", without shell metacharacters' },
)

/** The program reference one call may name a target with. */
export const targetRefSchema = z.string().trim().min(1).max(256)

/** What one file transfer call may send. */
export const transferInputSchema = z.object({
  target: targetRefSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  path: remotePathSchema,
  localPath: z.string().min(1).max(4096),
  localDir: z.string().min(1).max(4096).optional(),
  recursive: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  maxBytes: z.number().int().min(MIN_MAX_TRANSFER_BYTES).max(MAX_MAX_TRANSFER_BYTES).optional(),
  timeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).optional(),
}).strict()

/** What one conversation-target call may send. */
export const sessionTargetInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  targetId: idSchema.optional(),
}).strict()

/** What the page or the tool layer may send for one remote command. */
export const remoteRunSchema = z.object({
  command: z.string().trim().min(1).max(8192).refine(
    value => !/[\0]/u.test(value),
    { message: 'A remote command cannot contain a NUL byte' },
  ),
  target: targetRefSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  timeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).optional(),
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).optional(),
  /** Ask the server for a pseudo-terminal, for a command that needs one. */
  tty: z.boolean().optional(),
  /** Text sent to the command's stdin, for a prompt answer or a piped body. */
  input: z.string().max(1_000_000).optional(),
}).strict()

/** The one domain this plugin owns. */
export const sshTargetsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  compatibleVersions: COMPATIBLE_VERSIONS,
  global: { schema: settingsRecordSchema, initial: DEFAULT_SETTINGS },
  tables: {
    connections: domainTable<string, ConnectionRecord>(connectionRecordSchema),
    sessions: domainTable<string, SessionTarget>(sessionTargetSchema),
  },
})
