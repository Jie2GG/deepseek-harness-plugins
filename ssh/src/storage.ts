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
 * ceilings (the executable is detected now, and the probe deadline is fixed);
 * 5 = added the per-target `pool` switch for connection sharing.
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
 * still edits — the executable is detected and the probe deadline is fixed — and
 * 5 added the per-target `pool` switch. The current schemas accept every earlier
 * shape, and a stored record with no `pool` shares by default, so no stored file
 * is rewritten or refused on upgrade.
 */
export const DOMAIN_VERSION = 5

/** Older stored records the current schemas still accept. */
export const COMPATIBLE_VERSIONS = [1, 2, 3, 4]

/** Ceiling on how many targets the page may keep. */
export const MAX_CONNECTIONS = 64

/**
 * Ceiling on how many remote operations run at once, counting the page's probes
 * and every agent call alike. With connections shared per target this is no
 * longer a count of TCP sessions — it is how many local `ssh` children the Host
 * may hold, which is what actually costs this machine.
 */
export const MAX_CONCURRENT_OPS = 16

/** Ceiling on how many servers may hold an open shared master at once. */
export const MAX_LIVE_MASTERS = 8

/**
 * How long a master stays up after its last call hung up, in seconds. Long
 * enough that a conversation's next few commands ride along on the connection
 * that already authenticated; short enough that a master abandoned by a killed
 * Host stops counting against the server on its own.
 */
export const CONTROL_PERSIST_SECONDS = 300

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
 * The deadline one connectivity probe waits to.
 *
 * Thirty seconds, fixed in code: the page's test is not a request a reader wants
 * to tune, and every deployment that ever had a knob for it left it alone. The
 * budget splits itself — the connect phase takes a third of it (capped at 10 s),
 * so a host nobody answers still fails fast, and what the rest covers is a slow
 * link, a jump host, and a key exchange with an authentication round.
 *
 * What the probe dials for depends on whether the call carries a shared
 * connection: `ssh -N` ends on its own the instant authentication finishes when a
 * master is being left behind in the background, and sits idle until its deadline
 * when nothing will be. `STAT_TIMEOUT_MS` is the separate, shorter budget for the
 * one remote `stat` a download asks first, which used to ride on this constant.
 */
export const PROBE_TIMEOUT_MS = 30_000

/**
 * The deadline for the size and type pre-check one download asks before it
 * copies. The answer is a local file's metadata, so it is not given the probe's
 * thirty seconds: a stalled server should not stall a copy that was about to
 * start.
 */
export const STAT_TIMEOUT_MS = 10_000

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

/**
 * Whether one target may share its connection with later calls. `on` is the
 * default and the stored default: sharing is invisible except in speed, and a
 * target switches off only when its server misbehaves around a multiplexed one.
 */
export const poolChoiceSchema = z.enum(['on', 'off'])

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
  /** Whether later calls to this target ride on this call's connection. */
  pool: poolChoiceSchema.default('on'),
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
  pool: poolChoiceSchema.optional(),
  allowedCommands: z.array(programSchema).max(MAX_ALLOWED_COMMANDS).optional(),
  remoteTimeoutMs: z.number().int().min(MIN_REMOTE_TIMEOUT_MS).max(MAX_REMOTE_TIMEOUT_MS).nullable().optional(),
  maxOutputBytes: z.number().int().min(MIN_MAX_OUTPUT_BYTES).max(MAX_MAX_OUTPUT_BYTES).nullable().optional(),
}).strict()

/** What a `save` may write into the credential store. */
export const secretPatchSchema = z.object({
  password: z.string().min(1).max(4096).nullable().optional(),
  passphrase: z.string().min(1).max(4096).nullable().optional(),
  /** The root account's own password, which `su` elevation answers with. */
  root: z.string().min(1).max(4096).nullable().optional(),
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
  pool: poolChoiceSchema.optional(),
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
  /**
   * Elevation through sudo: run the command as this account. `root` is the
   * plain elevation case; any other name needs that account reachable by
   * `sudo -u`. The plugin injects the target's stored login password when the
   * call is not already given an `input` and no NOPASSWD is configured.
   */
  as: z.string().trim().regex(/^[a-z_][a-z0-9._-]{0,63}$/u, {
    message: 'Expected a bare account name such as root or postgres',
  }).optional(),
  /**
   * Elevation through su: switch to root with the root account's own stored
   * password (the third secret slot), for hosts where sudo is unavailable and
   * the root password differs from the login password.
   */
  su: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.as !== undefined && value.su === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'as and su are alternatives: sudo reaches an account through the login password, su through the stored root password. Pick one.',
      path: ['su'],
    })
  }
})

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
