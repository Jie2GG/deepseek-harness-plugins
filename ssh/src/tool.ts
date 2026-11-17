/**
 * The agent-facing surface: one `remote` tool over the same operations the
 * settings page drives, plus the policy gate that asks a human before a call
 * changes anything on the server.
 *
 * Two rules keep the two callers honest:
 *
 * - One operation, one implementation. Every action here calls the same `ops`
 *   method the browser route calls, so a command run from the chat and a command
 *   run from the page cannot drift apart.
 * - Deployment policy lives in `tools/pre-execute`. The gate answers allow, deny,
 *   or ask; the harness resolves an `ask` through its own approval UI and turns a
 *   missing approval service into a denial rather than a silent pass. The tool
 *   body re-checks only the hard stop (`agentAccess: off`), because it cannot
 *   know whether the gate already obtained consent.
 *
 * @module @jie2gg/dsh-plugin-ssh/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApprovalAnswer } from './approval.ts'

/**
 * The pending-call fields this module reads, taken structurally: two copies of the
 * core packages (this bundle's dependency and the Host's own) must not turn an
 * ordinary callback into two unrelated nominal types.
 */
/** The cancellation handle one call carries. */
export interface CallSignal {
  /** Aborted when the caller cancels; every awaited operation must honour it. */
  readonly signal: AbortSignal
}

export interface PendingCall {
  /** The tool the call is for. */
  readonly name: string
  /** The parsed arguments, before validation. */
  readonly arguments?: unknown
  /** The calling agent, whose Session id names the conversation. */
  readonly agent?: unknown
}

/** The allow / deny / cancel / ask decision a pre-execute listener returns. */
export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } }
import { leadingProgram, DRAIN_MS } from './transport.ts'
import { defaultBounds } from './bounds.ts'
import type { Bounds } from './bounds.ts'
import type { Ops, Params, RemoteFileResult } from './ops.ts'

/** Actions the tool offers: reads (`get_connection`, `read`, `download`) and writes (`exec`, `write`, `edit`, `upload`). */
export const REMOTE_TOOL_ACTIONS = ['get_connection', 'exec', 'read', 'write', 'edit', 'upload', 'download'] as const

/** Preferred tool name, with a namespaced fallback if another plugin holds it. */
/** The wire name this plugin claims. */
export const REMOTE_TOOL_NAME = 'ssh_client'
/** The name used when another plugin already holds the primary name. */
export const REMOTE_TOOL_FALLBACK_NAME = 'ssh_remote'

/** What the policy layer needs to know about one stored target. */
export interface TargetSnapshot {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  agentAccess: 'on' | 'off'
  allowedCommands: readonly string[]
  /** Whether this target's calls may ride one shared connection. */
  pool: 'on' | 'off'
}

/** Dependencies the plugin entry wires once, at activation. */
export interface RemoteToolDeps {
  /** The operations the browser route uses too. */
  ops: () => Promise<Ops>
  /** Current targets, for the gate, for `targets`, and for resolution. */
  catalog: () => Promise<TargetSnapshot[]>
  /** The conversation a call belongs to, when one is known. */
  sessionOf?: ((exec: Readonly<PendingCall>) => string | undefined) | undefined
  /** The target one conversation chose, read from the plugin's own storage. */
  sessionTargetOf?: ((sessionId: string) => string | undefined) | undefined
  /**
   * The saved aliases, read at build time. The parameter DSL takes only static
   * strings — `defineTool` projects the schema once, so a thunk would freeze —
   * which is why a changed inventory makes the caller re-register rather than
   * pretend the list updates in place.
   */
  targetsOf?: (() => TargetBrief[]) | undefined
  /** The conversation workspace one transfer call may touch. */
  local?: RemoteLocalBridge | undefined
  /**
   * Whether this conversation can answer a request at all. A session whose approval
   * policy is `never` resolves every ask as rejected — decided inside the approval
   * service before any listener runs — so asking there is not a question, it is a
   * refusal the plugin authored itself.
   */
  approvalPolicyOf?: ((exec: Readonly<PendingCall>) => ApprovalAnswer | undefined) | undefined
  /**
   * The live bounds, so the declared tool-call budget can sit above the longest
   * deadline this plugin will wait to. Read at registration; a profile that raises
   * a cap re-registers on the next inventory change. An assembly that brings none
   * gets the published defaults, each cap at the height of its own default.
   */
  boundsOf?: (() => Bounds) | undefined
}

/** One saved target as the tool description presents it to the model. */
export interface TargetBrief {
  /** The alias the model should pass. */
  label: string
  /** Where that alias goes. */
  host: string
  /** The user the probe would send, when the record names one. */
  user?: string | undefined
}

/**
 * The local side of a transfer, resolved through the Host services the tool call
 * belongs to: the conversation workspace, and whether a path is already taken.
 */
export interface RemoteLocalBridge {
  /** The session workspace an absolute local path must stay inside. */
  dirOf(exec: Readonly<PendingCall>): Promise<string | undefined>
  /** Whether something already exists at that local path. */
  exists(localPath: string): Promise<boolean>
  /** Join a relative path onto the workspace, rejecting an escape. */
  resolve(localPath: string, dir: string): string
  /**
   * Ask the file pipeline what the next local write is allowed to be, **before**
   * the copy starts: the session's change recorder listens to this waterfall and
   * captures the before-image from it, and a plugin that lets an external process
   * (`scp`) do the writing is the shape that waterfall is meant to cover.
   * @param localPath - the absolute destination.
   * @param exec - the pending call, passed as the actor so the edit is attributed.
   * @returns the guard the pipeline decided on, or `undefined` when none applies.
   */
  writeIntent?: ((localPath: string, exec: Readonly<PendingCall>) => Promise<LocalWriteGuard | undefined>) | undefined
}

/**
 * The one decision `fs/write-intent` can hand back that this plugin can honour:
 * a create that must not replace what is already there. `replaceIfVersion` carries
 * an opaque token the plugin cannot re-check around an external writer, so it is
 * reported rather than silently ignored.
 */
export type LocalWriteGuard = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion' }

/** One tool call's parameters as the registry decoded them. */
export interface RemoteCallArgs {
  action: (typeof REMOTE_TOOL_ACTIONS)[number]
  command?: string | undefined
  target?: string | undefined
  path?: string | undefined
  content?: string | undefined
  oldText?: string | undefined
  newText?: string | undefined
  all?: boolean | undefined
  replaceFirst?: boolean | undefined
  backup?: boolean | undefined
  overwrite?: boolean | undefined
  append?: boolean | undefined
  mkdir?: boolean | undefined
  recursive?: boolean | undefined
  timeoutMs?: number | undefined
  maxBytes?: number | undefined
  /** For `exec`: ask the server for a pseudo-terminal. */
  tty?: boolean | undefined
  /** For `exec`: text fed to the command's stdin. */
  input?: string | undefined
  /** For `exec`: start it as a background job instead of waiting. */
  background?: boolean | undefined
  /** For `exec`: run as another account through sudo; `root` is the plain elevation. */
  as?: string | undefined
  /** For `exec`: switch to root through su, answered with the stored root password. */
  su?: boolean | undefined
  /** For `upload`/`download`: the path on this machine, relative to the session workspace. */
  localPath?: string | undefined
}

/** A policy verdict, with the text a human would read. */
export interface PolicyVerdict {
  verdict: 'allow' | 'ask' | 'deny'
  reason: string
  display?: { en: string; zh: string } | undefined
}

/**
 * Read the call's arguments defensively: the gate sees them before the body, and
 * a malformed call must produce a refusal, never a crash.
 * @param exec - the pending call.
 * @returns the action and the fields the policy needs.
 */
export function readArgs(exec: Readonly<PendingCall>): RemoteCallArgs {
  const raw = (exec.arguments ?? {}) as Record<string, unknown>
  const action = typeof raw.action === 'string' ? (raw.action as (typeof REMOTE_TOOL_ACTIONS)[number]) : 'exec'
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
  const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    action,
    command: text(raw.command),
    target: text(raw.target),
    path: text(raw.path),
    content: text(raw.content),
    overwrite: raw.overwrite === true,
    append: raw.append === true,
    mkdir: typeof raw.mkdir === 'boolean' ? raw.mkdir : undefined,
    timeoutMs: number(raw.timeoutMs),
    maxBytes: number(raw.maxBytes),
    // Every field the interface declares is mapped here: the dispatch and the gate
    // both read this one view, and a field left out silently arrives as "missing"
    // with a message that blames the caller for something it did pass.
    localPath: text(raw.localPath),
    recursive: typeof raw.recursive === 'boolean' ? raw.recursive : undefined,
    oldText: text(raw.oldText),
    newText: typeof raw.newText === 'string' ? raw.newText : undefined,
    all: typeof raw.all === 'boolean' ? raw.all : undefined,
    replaceFirst: typeof raw.replaceFirst === 'boolean' ? raw.replaceFirst : undefined,
    backup: typeof raw.backup === 'boolean' ? raw.backup : undefined,
    tty: typeof raw.tty === 'boolean' ? raw.tty : undefined,
    input: typeof raw.input === 'string' ? raw.input : undefined,
    background: typeof raw.background === 'boolean' ? raw.background : undefined,
    as: text(raw.as),
    su: typeof raw.su === 'boolean' ? raw.su : undefined,
  }
}

/**
 * Find the snapshot a call means, mirroring `ops.pickTarget`: an explicit
 * reference first, then the conversation's chosen target, then a lone target.
 * @param catalog - the stored targets.
 * @param args - the call arguments.
 * @param sessionTarget - the conversation's chosen target id, when it has one.
 * @returns the resolved target, or `undefined` when the call is ambiguous.
 */
export function findTarget(catalog: readonly TargetSnapshot[], args: RemoteCallArgs, sessionTarget?: string): TargetSnapshot | undefined {
  const ref = (args.target ?? '').trim().toLowerCase()
  if (ref !== '') {
    const direct = catalog.find(row => row.id === args.target?.trim()
      || row.label.toLowerCase() === ref
      || row.host.toLowerCase() === ref
      || (row.user !== undefined && `${row.user}@${row.host}`.toLowerCase() === ref))
    return direct
  }
  if (sessionTarget !== undefined) {
    const chosen = catalog.find(row => row.id === sessionTarget)
    if (chosen !== undefined) return chosen
  }
  return catalog.length === 1 ? catalog[0] : undefined
}

/**
 * Decide whether one call may run as it is, must ask a human, or is refused.
 *
 * The rule the settings page documents: `ls`, `read`, and `targets` are reads;
 * `write` changes the server; `run` is free only for a program the target
 * allowlists, and an empty allowlist means every command is asked about.
 * @param target - the resolved target, or `undefined` when it is unresolved.
 * @param args - the call arguments.
 * @returns the verdict and the text to show a human.
 */
export function decideAccess(target: TargetSnapshot | undefined, args: RemoteCallArgs): PolicyVerdict {
  if (args.action === 'get_connection') return { verdict: 'allow', reason: '' }
  // An unresolved or ambiguous target is the body's problem: it refuses with the
  // candidate list, which is more useful than a policy prompt about nothing.
  if (target === undefined) return { verdict: 'allow', reason: '' }
  if (target.agentAccess === 'off') {
    return {
      verdict: 'deny',
      reason: `"${target.label}" is set to agent access off in Settings → Remote connections.`,
      display: {
        en: `This target has agent access turned off, so nothing may run on ${target.label}.`,
        zh: `「${target.label}」已关闭 agent 访问，因此不能在上面执行任何操作。`,
      },
    }
  }
  const authority = target.user === undefined ? target.host : `${target.user}@${target.host}`
  // One read answers a listing or the text of a file; both are reads.
  if (args.action === 'read') {
    return { verdict: 'allow', reason: '' }
  }
  if (args.action === 'upload') {
    return {
      verdict: 'ask',
      reason: `Upload ${args.localPath ?? '<local path>'} to ${authority}:${args.path ?? '<remote path>'}.`,
      display: {
        en: `Copy a local file up to ${authority}: ${args.path ?? '(no remote path given)'}.`,
        zh: `将本地文件上传到 ${authority}：${args.path ?? '（未给出远端路径）'}。`,
      },
    }
  }
  // A download reads the server and writes inside the conversation workspace,
  // which the file pipeline already governs; asking twice would be noise.
  if (args.action === 'download') return { verdict: 'allow', reason: '' }
  if (args.action === 'edit') {
    return {
      verdict: 'ask',
      reason: `Edit ${args.path ?? '<remote path>'} on ${authority}: replace ${JSON.stringify((args.oldText ?? '').slice(0, 120))} with ${JSON.stringify((args.newText ?? '').slice(0, 120))}.`,
      display: {
        en: `Edit a file on ${authority}: ${args.path ?? '(no path given)'}. The text it replaces is quoted in the reason.`,
        zh: `将在 ${authority} 上编辑文件：${args.path ?? '（未给出路径）'}。被替换的文本在理由里引用。`,
      },
    }
  }
  if (args.action === 'write') {
    return {
      verdict: 'ask',
      reason: `Write ${args.path ?? '<path>'} on ${authority}.`,
      display: {
        en: `Write a file on ${authority}: ${args.path ?? '(no path given)'}${args.overwrite === true ? ' (replacing an existing file)' : ''}.`,
        zh: `将在 ${authority} 上写入文件：${args.path ?? '（未给出路径）'}${args.overwrite === true ? '（会替换已有文件）' : ''}。`,
      },
    }
  }
  const command0 = (args.command ?? '').trim()
  // Elevation is its own question: sudo/su can run anything as another
  // account, so a bare allowlist hit on the inner command never skips asking.
  // The secrets this path spends are the stored ones, and the prompt says so.
  const elevatedTo = args.as !== undefined && args.as !== '' ? args.as : args.su === true ? 'root' : undefined
  if (elevatedTo !== undefined) {
    const via = args.su === true ? 'su, with the stored root password' : 'sudo, with the stored login password'
    return {
      verdict: 'ask',
      reason: `Run elevated as ${elevatedTo} on ${authority}: ${command0.slice(0, 300)}`,
      display: {
        en: `Run a command on ${authority} as the ${elevatedTo} account through ${via}: ${command0.slice(0, 400)}. The plugin answers the prompt itself; no password appears in the conversation.`,
        zh: `将在 ${authority} 上以 ${elevatedTo} 身份执行命令（${args.su === true ? 'su：用已存的 root 密码应答' : 'sudo：用已存的登录密码应答'}）：${command0.slice(0, 400)}。提示由插件自己应答，对话里不会出现密码。`,
      },
    }
  }
  const program = leadingProgram(command0)
  if (program !== undefined && target.allowedCommands.includes(program)) {
    return { verdict: 'allow', reason: '' }
  }
  const why = program === undefined
    ? 'the command chains, redirects, or substitutes, so its effect is not one plain program'
    : `"${program}" is not in this target's allowlist`
  return {
    verdict: 'ask',
    reason: `Run on ${authority}: ${command0.slice(0, 300)}`,
    display: {
      en: `Run a command on ${authority} — ${command0.slice(0, 400)} — because ${why}.`,
      zh: `将在 ${authority} 上执行命令：${command0.slice(0, 400)}（原因：${program === undefined ? '这条命令有串接、重定向或替换，不是单个程序' : `「${program}」不在该目标的白名单里`}）。`,
    },
  }
}

/**
 * The `tools/pre-execute` decision for one call, swallowing nothing: a broken
 * catalog read becomes a denial with the reason, because running blind on a
 * remote server is the worse failure.
 * @param deps - the wired dependencies.
 * @param exec - the pending call.
 * @param next - the waterfall's pass-through.
 * @returns the decision the pipeline applies.
 */
/**
 * Whether an ask would reach someone who can answer it.
 * @param deps - the tool dependencies.
 * @param exec - the pending call.
 * @returns true when the conversation has a live approval surface.
 */
function awaitable(deps: RemoteToolDeps, exec: Readonly<PendingCall>): boolean {
  if (deps.approvalPolicyOf === undefined) return true
  try {
    return deps.approvalPolicyOf(exec) === 'ask'
  } catch {
    return true
  }
}

export async function gateRemoteCall(deps: RemoteToolDeps, exec: Readonly<PendingCall>, next: () => Promise<GateDecision>): Promise<GateDecision> {
  const args = readArgs(exec)
  if (!REMOTE_TOOL_ACTIONS.includes(args.action)) return await next()
  let catalog: TargetSnapshot[]
  try {
    catalog = await deps.catalog()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'deny', reason: `The ssh plugin could not read its saved targets, so it refused to touch a remote host: ${message.slice(0, 300)}` }
  }
  const sessionId = deps.sessionOf?.(exec)
  const chosen = sessionId === undefined || (args.target ?? '').trim() !== '' ? undefined : deps.sessionTargetOf?.(sessionId)
  const target = findTarget(catalog, args, chosen)
  const verdict = decideAccess(target, args)
  if (verdict.verdict === 'allow') return await next()
  if (verdict.verdict === 'deny') return { kind: 'deny', reason: verdict.reason }
  if (!awaitable(deps, exec)) {
    // Nobody is going to answer: run it, and let the deployment's standing decision
    // be the consent. A `deny` stays a deny — that one is the user's own setting on
    // the target, not a question.
    return await next()
  }
  return { kind: 'ask', reason: verdict.reason, ...(verdict.display === undefined ? {} : { displayReason: verdict.display }) }
}

/**
 * Every payload below is returned as the schema-inferred canonical value slot:
 * `defineTool` derives a per-`oneOf`-branch union from `output.schema`, and the
 * registry validates the value against that schema when the call settles, so the
 * shape is checked at the boundary that matters (and asserted directly by the
 * offline suite) instead of being restated in TypeScript.
 */
/** The canonical payload shape one action returns. */
const TARGET_SHAPE = {
  id: { type: 'string', required: true },
  label: { type: 'string', required: true },
  host: { type: 'string', required: true },
  user: { type: 'string' },
  port: { type: 'integer' },
  auth: { type: 'string', enum: ['key', 'key+password', 'password'] },
  agentAccess: { type: 'string', enum: ['on', 'off'] },
  pool: { type: 'string', enum: ['on', 'off'] },
  allowedCommands: { type: 'array', items: { type: 'string' } },
  hasPassword: { type: 'boolean' },
  hasPassphrase: { type: 'boolean' },
  hasRoot: { type: 'boolean' },
  lastProbe: { type: 'string' },
} as const

/** The common fields every branch carries, so the renderer has one shape to read. */
const OUTCOME_SHAPE = {
  action: { type: 'string', required: true },
  ok: { type: 'boolean', required: true },
  status: { type: 'string' },
  message: { type: 'string' },
  hint: { type: 'string' },
  resolvedVia: { type: 'string', enum: ['argument', 'session', 'only-target'] },
  /**
   * Every action reports what the child exited with and how long it took, so both
   * live in the shared shape: keeping them per-branch is how a read payload came to
   * match no branch at all and the registry rejected the whole call.
   */
  exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  durationMs: { type: 'integer' },
  target: {
    type: 'object',
    properties: {
      id: { type: 'string', required: true },
      label: { type: 'string', required: true },
      host: { type: 'string', required: true },
      user: { type: 'string' },
      port: { type: 'integer' },
    },
    additionalProperties: false,
  },
} as const

/**
 * The tool description the model reads, naming the aliases it may choose between.
 * @param targets - the saved targets, in the order the page lists them.
 * @returns the description text.
 */
export function describeRemote(targets: TargetBrief[]): string {
  const list = targets.length === 0
    ? 'No SSH target is saved yet: call `get_connection` after the user adds one in Settings → Remote connections.'
    : `Choose the server this conversation means and pass it as \`target\`. Available aliases: ${targets
      .map(target => `\`${target.label}\` (${target.user === undefined || target.user === '' ? '' : `${target.user}@`}${target.host})`)
      .join(', ')}.`
  return `Runs commands and moves files on a stored SSH server, with the credentials the plugin holds. ${list} A call addresses one server: leave \`target\` out to reuse the one this conversation last used. Nothing is interpreted by a local shell; the command string is executed by the login shell on the server. \`get_connection\`, \`read\`, and \`download\` are reads; \`read\` answers with a directory listing when the path is a directory and with the file's text when it is a file; \`exec\`, \`write\`, \`edit\`, and \`upload\` may be refused by the user, and an \`exec\` runs unasked only when its one bare leading program is named by that target's command allowlist — a fresh target names no programs there, so every command on it is asked about first. Pass \`as: "root"\` (or another account) to elevate through sudo, or \`su: true\` to reach root with the stored root password: either way the plugin injects the secret into the command's own stdin, so no password ever appears in the conversation. Add \`background: true\` to leave a long command running, then poll it with the harness's \`job_output\` and \`job_kill\` tools. Calls to one server share the connection the first of them opened, which is why several can run at once; a target shown as \`pool off\` dials a fresh connection every time.`
}

/**
 * The parameter hint for `target`, listing the same aliases.
 * @param targets - the saved targets.
 * @returns the parameter description.
 */
export function targetParamHint(targets: TargetBrief[]): string {
  if (targets.length === 0) {
    return 'Which saved SSH target to use: its id, display name, or host (optionally `user@host`). None is saved yet, so the call will report the candidates.'
  }
  return `Which SSH target to address: one of ${targets.map(target => `\`${target.label}\``).join(', ')}, or its id, host, or \`user@host\`. Omit it to reuse the target this conversation last used.`
}

/**
 * Build the tool definition over the wired dependencies.
 * @param deps - the operations, the catalog reader, and the session hook.
 * @returns the definition the plugin registers.
 */
/**
 * Keep the target the model picked for this conversation, so the next call can
 * leave `target` out. Only an explicitly named target is remembered: a call that
 * resolved through the stored choice or a lone saved server would write noise.
 * @param operations - the shared operations object.
 * @param sessionId - the conversation, when one is known.
 * @param call - the call as read.
 * @param payload - the result, whose `target` names what was used.
 * @returns resolution once the write lands; failures are swallowed.
 */
async function rememberSessionTarget(
  operations: Ops,
  sessionId: string | undefined,
  call: RemoteCallArgs,
  payload: unknown,
): Promise<void> {
  if (sessionId === undefined || sessionId === '') return
  if (typeof call.target !== 'string' || call.target.trim() === '') return
  const record = payload as { target?: { id?: unknown }; run?: { target?: { id?: unknown } } } | null
  const state = payload as { ok?: unknown } | null
  if (state?.ok !== true) return
  const direct = record?.target?.id
  const nested = record?.run?.target?.id
  const targetId = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : ''
  if (targetId === '') return
  try {
    await operations.setSessionTarget({ sessionId, targetId })
  } catch {
    // A failed memory is not a failed remote call.
  }
}

/**
 * Slack on top of the longest internal wait, so a call that reaches its own
 * deadline always answers before the harness wrapper answers for it. The wrapper in
 * `guard/timeout-policy` replaces whatever the tool returned with
 * `Error: tool call timed out after <N>ms`, and a plugin whose budget equals its
 * internal deadline is a plugin that loses its own classification to a race.
 */
const BUDGET_SLACK_MS = 5_000

export function buildRemoteTool(deps: RemoteToolDeps): ToolDefinition {
  // The worst case this plugin can wait to: the capped command deadline, the kill
  // grace the provider gets, the pipe drain, and the slack above that.
  const bounds = (deps.boundsOf ?? defaultBounds)()
  const callBudgetMs = bounds.maxTimeoutMs + bounds.graceMs + DRAIN_MS + BUDGET_SLACK_MS
  return defineTool({
    name: REMOTE_TOOL_NAME,
    description: describeRemote(deps.targetsOf?.() ?? []),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...REMOTE_TOOL_ACTIONS],
        description: 'What to do: `get_connection` lists what is saved and resolves which server this call would address, without connecting; `exec` runs one shell command on it; `read` returns a directory listing or the text of a file, depending on what the path is; `write` sends text to a remote path; `edit` replaces exact text inside a remote file (it refuses an ambiguous match instead of guessing); `upload` and `download` move files.',
      },
      target: { type: 'string', description: targetParamHint(deps.targetsOf?.() ?? []) },
      command: { type: 'string', description: 'For `exec`: the command line to execute on the server, as one string. Quote anything that must survive the remote shell.' },
      path: { type: 'string', description: 'For `ls`, `read`, `write`: an absolute remote path, or one starting with `~/`. Shell metacharacters are refused.' },
      content: { type: 'string', description: 'For `write`: the exact text to put in the remote file; it is sent on stdin, never as an argument.' },
      overwrite: { type: 'boolean', description: 'For `write`: replace an existing remote file instead of refusing.' },
      append: { type: 'boolean', description: 'For `write`: append to the remote file instead of replacing it.' },
      mkdir: { type: 'boolean', description: 'For `write`: create the parent directory first. Defaults to true.' },
      localPath: { type: 'string', description: 'For `upload` and `download`: the path on this machine. Relative paths are resolved inside the conversation workspace, and a path outside it is refused.' },
      recursive: { type: 'boolean', description: 'For `upload` and `download`: move a directory rather than one file.' },
      timeoutMs: { type: 'integer', description: 'For `exec`: the deadline for this call, in milliseconds. The plugin applies its configured default and cap — a number above the cap is capped to it and the effective value is echoed back, never refused.' },
      background: { type: 'boolean', description: 'For `exec`: start the command as a background job and return its id at once instead of waiting for it. Poll it with the `job_output` tool and stop it with `job_kill`; the command also ends when this conversation ends.' },
      maxBytes: { type: 'integer', description: 'For `exec` and `read`: the largest amount of output to bring back.' },
      tty: { type: 'boolean', description: 'For `exec`: run under `ssh -tt`, for a program that inspects its own terminal (it then merges stderr into stdout and ends lines with CRLF).' },
      input: { type: 'string', description: 'For `exec`: text fed to the command stdin, to answer a prompt or pipe a body.' },
      oldText: { type: 'string', description: 'For `edit`: the exact text to find, copied from a read; it must match once unless `all` or `replaceFirst` is set.' },
      newText: { type: 'string', description: 'For `edit`: the replacement text; an empty string deletes the match.' },
      all: { type: 'boolean', description: 'For `edit`: replace every occurrence instead of refusing when the text matches more than once.' },
      replaceFirst: { type: 'boolean', description: 'For `edit`: replace only the first occurrence when the text matches more than once.' },
      backup: { type: 'boolean', description: 'For `edit`: defaults to true, leaving a `<path>.dsh-bak` copy; pass false to skip it.' },
      as: { type: 'string', description: 'For `exec`: run the command as another account through sudo (`root` for the plain elevation). The plugin forces a terminal and answers sudo with the target\u2019s stored login password; the password never appears in the conversation.' },
      su: { type: 'boolean', description: 'For `exec`: switch to root through su, answered with the target\u2019s stored root password (a third secret slot, set in the target form). Use when sudo is unavailable and root\u2019s password differs from the login password. Cannot be combined with `as`, and not available for backgrounded commands.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'edit', required: true }, path: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory', 'other', 'missing'] }, replaced: { type: 'integer' }, matches: { type: 'integer' }, bytesBefore: { type: 'integer' }, bytesAfter: { type: 'integer' }, backup: { type: 'string' }, size: { type: 'integer' }, durationMs: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', enum: ['upload', 'download'], required: true }, localPath: { type: 'string' }, remotePath: { type: 'string' }, bytes: { type: 'integer' }, recursive: { type: 'boolean' }, overwrote: { type: 'boolean' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'get_connection', required: true }, selectedId: { type: 'string' }, selectedLabel: { type: 'string' }, selectedHost: { type: 'string' }, selectedUser: { type: 'string' }, selectedVia: { type: 'string' }, targets: { type: 'array', items: { type: 'object', properties: TARGET_SHAPE, additionalProperties: false } }, count: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'exec', required: true }, command: { type: 'string' }, jobId: { type: 'string' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, stdout: { type: 'string' }, stderr: { type: 'string' }, truncated: { type: 'boolean' }, stdoutSpillPath: { type: 'string' }, stderrSpillPath: { type: 'string' }, timeoutMs: { type: 'integer' }, outputBytes: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } }, elevated: { type: 'string' }, durationMs: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'read', required: true }, path: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory', 'other', 'missing'] }, size: { type: 'integer' }, content: { type: 'string' }, entriesText: { type: 'string' }, bytes: { type: 'integer' }, lines: { type: 'integer' }, truncated: { type: 'boolean' }, stdoutSpillPath: { type: 'string' }, timeoutMs: { type: 'integer' }, outputBytes: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } }, durationMs: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'write', required: true }, path: { type: 'string' }, bytes: { type: 'integer' }, overwrote: { type: 'boolean' }, durationMs: { type: 'integer' } },
          },
        ],
      },
      render: (args, value) => [{ type: 'text', text: renderCall(args as RemoteCallArgs, value as Record<string, unknown>) }],
      presentationMeta: (_args, value) => {
        const payload = value as Record<string, unknown>
        const target = payload.target as { label?: string; host?: string } | undefined
        // The DSL infers a strict JsonValue here, so the card is handed only these
        // three scalars; the status, exit code, and duration a reader wants are
        // parsed from the rendered body line, whose format this module owns.
        return {
          action: typeof payload.action === 'string' ? payload.action : 'exec',
          ok: payload.ok === true,
          label: target?.label ?? target?.host ?? '',
        }
      },
    },
    timeoutMs: callBudgetMs,
    presentCall: (args) => {
      const call = args as RemoteCallArgs
      const label = call.command !== undefined ? call.command : call.path ?? call.action
      return { card: 'generic', title: `${REMOTE_TOOL_NAME} ${call.action}`, kind: call.action === 'exec' ? 'execute' : call.action === 'write' || call.action === 'edit' || call.action === 'upload' ? 'edit' : 'read', rawInput: String(label).slice(0, 400) }
    },
    async execute(args, exec) {
      const call = args as RemoteCallArgs
      const operations = await deps.ops()
      const params: Params = {}
      if (call.target !== undefined) params.target = call.target
      const sessionId = deps.sessionOf?.(exec)
      if (sessionId !== undefined) params.sessionId = sessionId
      // The registry keeps these so the job's lifecycle record names the call that
      // started it, the same way a backgrounded shell command does.
      const execCallId = typeof exec.callId === 'string' ? exec.callId : undefined
      const execRootCallId = typeof exec.rootCallId === 'string' ? exec.rootCallId : undefined
      switch (call.action) {
        case 'get_connection': {
          const listed = await operations.list()
          // Naming the server is why this call exists. The rules below are the same
          // ones the gate and every other action use, and nothing connects.
          const snapshots = listed.connections.map(row => ({
            id: row.id,
            label: row.label,
            host: row.host,
            ...(row.user === undefined ? {} : { user: row.user }),
            ...(row.port === undefined ? {} : { port: row.port }),
            agentAccess: row.agentAccess,
            allowedCommands: row.allowedCommands,
            pool: row.pool,
          }))
          const stored = sessionId === undefined || (call.target ?? '').trim() !== '' ? undefined : deps.sessionTargetOf?.(sessionId)
          const resolved = findTarget(snapshots, call, stored)
          return listedResult(listed.connections, listed.bounds, resolved === undefined ? undefined : {
            id: resolved.id,
            label: resolved.label,
            host: resolved.host,
            ...(resolved.user === undefined ? {} : { user: resolved.user }),
            via: (call.target ?? '').trim() !== '' ? 'argument' : stored !== undefined ? 'session' : 'only-target',
          }) as never
        }
        case 'exec': {
          if (call.command === undefined || call.command.trim() === '') {
            return { action: 'exec', ok: false, status: 'failed', message: 'A run call needs a command.', hint: 'Pass command, as one string.' } as never
          }
          params.command = call.command
          if (call.timeoutMs !== undefined) params.timeoutMs = call.timeoutMs
          if (call.maxBytes !== undefined) params.maxOutputBytes = call.maxBytes
          if (call.tty === true) params.tty = true
          if (call.input !== undefined) params.input = call.input
          if (call.as !== undefined) params.as = call.as
          if (call.su === true) params.su = true
          if (call.background === true) {
            // Handed to the job registry: the call answers with an id, and the
            // conversation reads and stops it with the harness's own job tools.
            if (sessionId !== undefined) params.sessionId = sessionId
            if (execCallId !== undefined) params.callId = execCallId
            if (execRootCallId !== undefined) params.rootCallId = execRootCallId
            const job = await operations.execBackground(params)
            await rememberSessionTarget(operations, sessionId, call, job)
            // Built field by field: the refreshed inventory is for the settings
            // page, and this action's schema declares no room for it.
            return {
              action: 'exec',
              ok: job.ok,
              status: job.status,
              target: job.target,
              command: job.command,
              jobId: job.jobId,
              ...(job.hint === undefined ? {} : { hint: job.hint }),
            } as never
          }
          const result = await operations.runCommand(params)
          // Remembered from the mapped payload: that is where the target this call
          // actually used is spelled out.
          const payload = runResult(result)
          await rememberSessionTarget(operations, sessionId, call, payload)
          return payload as never
        }
        case 'upload':
        case 'download': {
          if (call.path === undefined || call.path.trim() === '') {
            return { action: call.action, ok: false, status: 'failed', message: `An ${call.action} call needs a remote path.`, hint: 'Pass path: an absolute path on the server.' } as never
          }
          if (call.localPath === undefined || call.localPath.trim() === '') {
            return { action: call.action, ok: false, status: 'failed', message: `An ${call.action} call needs a local path.`, hint: 'Pass localPath, inside this conversation workspace.' } as never
          }
          const bridge = deps.local
          const dir = bridge === undefined ? undefined : await bridge.dirOf(exec)
          let local: string
          if (bridge !== undefined && dir !== undefined) {
            try {
              local = bridge.resolve(call.localPath, dir)
            } catch (error: unknown) {
              return { action: call.action, ok: false, status: 'failed', localPath: call.localPath, remotePath: call.path, message: error instanceof Error ? error.message : String(error), hint: 'Use a path inside the conversation workspace.' } as never
            }
          } else {
            local = call.localPath
          }
          params.localPath = local
          // Ask the file pipeline before scp touches the disk: the session's
          // change recorder captures its before-image from this waterfall, and a
          // create-only guard means a copy would clobber something the harness
          // decided this turn may not replace.
          if (call.action === 'download' && bridge?.writeIntent !== undefined) {
            const guard = await bridge.writeIntent(local, exec)
            if (guard?.kind === 'createIfAbsent' && call.overwrite !== true && await bridge.exists(local)) {
              return {
                action: 'download',
                ok: false,
                status: 'refused-exists',
                localPath: local,
                remotePath: call.path,
                message: `The file pipeline only allows a new file at ${local}, and one is already there.`,
                hint: 'Pick another localPath, or delete the existing file first.',
              } as never
            }
            if (guard?.kind === 'replaceIfVersion' && call.overwrite !== true) {
              return {
                action: 'download',
                ok: false,
                status: 'refused-exists',
                localPath: local,
                remotePath: call.path,
                message: `A transfer cannot honour the observed version the file pipeline requires for ${local}.`,
                hint: 'Pass overwrite when you mean to replace it.',
              } as never
            }
          }
          params.path = call.path
          if (call.overwrite === true) params.overwrite = true
          if (call.recursive === true) params.recursive = true
          if (call.maxBytes !== undefined) params.maxBytes = call.maxBytes
          const result = call.action === 'upload' ? await operations.upload(params) : await operations.download(params)
          await rememberSessionTarget(operations, sessionId, call, result)
          return { ...result, action: call.action } as never
        }
        case 'edit': {
          if (call.path === undefined || call.path.trim() === '') {
            return { action: 'edit', ok: false, status: 'failed', message: 'An edit call needs a remote path.', hint: 'Pass path: the file to change.' } as never
          }
          if (call.oldText === undefined || call.oldText === '') {
            return { action: 'edit', ok: false, status: 'failed', message: 'An edit call needs the exact text to find.', hint: 'Read the file first and copy the lines, indentation included.' } as never
          }
          if (call.newText === undefined) {
            return { action: 'edit', ok: false, status: 'failed', message: 'An edit call needs the replacement text.', hint: 'Pass newText, or an empty string to delete the match.' } as never
          }
          params.path = call.path
          params.oldText = call.oldText
          params.newText = call.newText
          if (call.all === true) params.all = true
          if (call.replaceFirst === true) params.replaceFirst = true
          if (call.backup === false) params.backup = false
          const edited = await operations.editRemote(params)
          await rememberSessionTarget(operations, sessionId, call, edited)
          return { ...edited } as never
        }
        case 'read':
        case 'write': {
          if (call.path === undefined || call.path.trim() === '') {
            return { action: call.action, ok: false, status: 'failed', message: `A ${call.action} call needs a remote path.`, hint: 'Pass path: an absolute path on the server.' } as never
          }
          params.path = call.path
          if (call.action === 'write') {
            if (call.content === undefined) {
              return { action: 'write', ok: false, status: 'failed', message: 'A write call needs content.', hint: 'Pass the exact text to write.' } as never
            }
            params.content = call.content
            params.overwrite = call.overwrite === true
            params.append = call.append === true
            params.mkdir = call.mkdir !== false
          }
          if (call.maxBytes !== undefined) params.maxOutputBytes = call.maxBytes
          const result: RemoteFileResult = call.action === 'read'
            ? await operations.readPath(params)
            : await operations.writeRemote(params)
          await rememberSessionTarget(operations, sessionId, call, result)
          return { ...result } as never
        }
      }
    },
  })
}

/**
 * Shape the `targets` result: presence of secrets and the last probe status, and
 * never a value.
 * @param connections - the stored rows with their secret presence.
 * @param settings - the shared ceilings, echoed for the reader.
 * @returns the canonical payload.
 */
/**
 * Shape the answer of `get_connection`: the saved inventory and, which is the point
 * of the call, the server a later call would actually address.
 * @param connections - the stored rows.
 * @param settings - the shared ceilings, folded into the summary line.
 * @param selected - the resolved target and how it was reached.
 * @returns the canonical payload.
 */
function listedResult(
  connections: Awaited<ReturnType<Ops['list']>>['connections'],
  bounds: Awaited<ReturnType<Ops['list']>>['bounds'],
  selected?: { id: string; label: string; host: string; user?: string | undefined; via: string } | undefined,
): Record<string, unknown> {
  return {
    action: 'get_connection',
    ok: true,
    count: connections.length,
    targets: connections.map(row => ({
      id: row.id,
      label: row.label,
      host: row.host,
      ...(row.user === undefined ? {} : { user: row.user }),
      ...(row.port === undefined ? {} : { port: row.port }),
      ...(row.auth === undefined ? {} : { auth: row.auth }),
      ...(row.agentAccess === undefined ? {} : { agentAccess: row.agentAccess }),
      ...(row.pool === undefined ? {} : { pool: row.pool }),
      ...(row.allowedCommands === undefined ? {} : { allowedCommands: [...row.allowedCommands] }),
      hasPassword: row.secrets?.password === true,
      hasPassphrase: row.secrets?.passphrase === true,
      hasRoot: row.secrets?.root === true,
      ...(row.lastProbe === undefined ? {} : { lastProbe: `${row.lastProbe.status} at ${row.lastProbe.at}` }),
    })),
    ...(selected === undefined ? {} : {
      selectedId: selected.id,
      selectedLabel: selected.label,
      selectedHost: selected.host,
      ...(selected.user === undefined ? {} : { selectedUser: selected.user }),
      selectedVia: selected.via,
    }),
    message: connections.length === 0
      ? 'No SSH target is saved yet. Add one under Settings → Remote connections, then choose it for this conversation.'
      // Stated as default / cap / in force, because a call that asks above the cap
      // is capped rather than refused — and a model that cannot see the cap has no
      // way to know its number was changed on it.
      : `Ceilings as this Host resolves them (default to cap, and what is in force): command ${String(bounds.timeoutMs)}–${String(bounds.maxTimeoutMs)} ms, in force ${String(bounds.effective.remoteTimeoutMs)} ms; output ${String(bounds.outputBytes)}–${String(bounds.maxOutputBytes)} bytes per stream, in force ${String(bounds.effective.maxOutputBytes)}; transfer ${String(bounds.transferBytes)}–${String(bounds.maxTransferBytes)} bytes, in force ${String(bounds.effective.maxTransferBytes)}. A number past the cap is capped to it, not refused.`,
  }
}

/**
 * Shape one remote command result.
 * @param result - what `ops.runCommand` returned.
 * @returns the canonical payload the renderer reads.
 */
function runResult(result: Awaited<ReturnType<Ops['runCommand']>>): Record<string, unknown> {
  const run = result.run
  const target = result.connection === undefined ? undefined : { id: result.connection.id, label: result.connection.label, host: result.connection.host }
  const failed = run.status !== 'succeeded'
  return {
    action: 'exec',
    ok: !failed,
    status: run.status,
    ...(target === undefined ? {} : { target }),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.stdout === undefined ? {} : { stdout: run.stdout }),
    ...(run.stderr === undefined ? {} : { stderr: run.stderr }),
    ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
    ...(run.stdoutSpillPath === undefined ? {} : { stdoutSpillPath: run.stdoutSpillPath }),
    ...(run.stderrSpillPath === undefined ? {} : { stderrSpillPath: run.stderrSpillPath }),
    ...(run.elevated === undefined ? {} : { elevated: run.elevated }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(failed ? { message: runHint(run.status, run.stderr) } : {}),
    ...(failed && run.status === 'auth-failed'
      ? {
          hint: run.elevated !== undefined
            ? 'The elevation prompt could not be answered: the stored password this call spent (login for sudo, root for su) is wrong or missing.'
            : 'Check the stored password, or switch the target to a key its agent already holds.',
        }
      : {}),
  }
}

/**
 * Plain-language explanation for a run that did not exit zero.
 * @param status - the classified outcome.
 * @param stderr - whatever the server said.
 * @returns the message to show.
 */
function runHint(status: string, stderr: string | undefined): string {
  switch (status) {
    case 'exit-nonzero':
      return 'The command ran and exited nonzero; that is the server refusing the command, not the connection.'
    case 'auth-failed':
      return 'The server reached but rejected the credential.'
    case 'unreachable':
      return 'The server did not accept the connection.'
    case 'unknown-host':
      return 'The host key was refused; a first contact is recorded automatically, so this usually means the key changed.'
    case 'timeout':
      return 'The call ran out of its deadline.'
    case 'cancelled':
      return 'The call was cancelled.'
    case 'ssh-missing':
      return 'No ssh program was found: the plugin tried ssh on PATH and the usual install locations.'
    default:
      return (stderr ?? 'The call failed.').slice(0, 400)
  }
}

/**
 * Render the model-facing text of one call.
 * @param args - the call arguments.
 * @param value - the validated canonical value.
 * @returns the finished blocks' text.
 */
function renderCall(args: RemoteCallArgs, value: Record<string, unknown>): string {
  const target = value.target as { label?: string; host?: string } | undefined
  const where = target?.label ?? target?.host ?? args.target ?? 'the selected target'
  const lines: string[] = []
  switch (String(value.action)) {
    case 'get_connection': {
      const rows = Array.isArray(value.targets) ? (value.targets as Record<string, unknown>[]) : []
      if (rows.length === 0) return String(value.message ?? 'No SSH target is saved yet.')
      if (typeof value.selectedLabel === 'string') {
        lines.push(`A later call would address: ${String(value.selectedLabel)} (${typeof value.selectedUser === 'string' ? `${String(value.selectedUser)}@` : ''}${String(value.selectedHost)}) — reached by ${String(value.selectedVia ?? 'argument')}.`)
      } else {
        lines.push('A later call could not choose a server: '
          + (rows.length > 1 ? `${String(rows.length)} targets are saved, so name one with \`target\`.` : 'name it with `target`, or the single saved target is used.'))
      }
      lines.push(`Saved SSH targets (${String(rows.length)}):`)
      for (const row of rows) {
        const authority = `${typeof row.user === 'string' ? `${row.user}@` : ''}${String(row.host)}`
        const bits = [
          String(row.label),
          authority,
          `auth=${String(row.auth ?? 'key')}`,
          row.agentAccess === 'off' ? 'agent off' : 'agent on',
          row.pool === 'off' ? 'pool off' : '',
          Array.isArray(row.allowedCommands) && row.allowedCommands.length > 0 ? `allowlist=${row.allowedCommands.join(',')}` : 'allowlist=none(ask every command)',
          row.hasPassword === true ? 'password stored' : '',
          row.hasPassphrase === true ? 'passphrase stored' : '',
          row.hasRoot === true ? 'root password stored' : '',
          typeof row.lastProbe === 'string' ? `last probe: ${row.lastProbe}` : '',
        ].filter(Boolean)
        lines.push(`- ${bits.join(' · ')}`)
      }
      if (typeof value.message === 'string') lines.push(value.message)
      return lines.join('\n')
    }
    case 'exec': {
      const command = typeof args.command === 'string' ? args.command : ''
      lines.push(`${where}$ ${command}`)
      if (typeof value.jobId === 'string') {
        lines.push(`Left running in the background as job ${String(value.jobId)}. Read it with \`job_output\` and stop it with \`job_kill\`.`)
      }
      const stdout = typeof value.stdout === 'string' ? value.stdout : ''
      const stderr = typeof value.stderr === 'string' ? value.stderr : ''
      if (stdout !== '') lines.push(stdout.replace(/\n$/u, ''))
      if (stderr !== '') lines.push(`[stderr] ${stderr.replace(/\n$/u, '')}`)
      // The shape the harness's own shell tool uses for this: the tail stays in
      // view, and the file holding the whole stream is named. "Truncated" should
      // point somewhere, not just report a loss — and when the profile turned
      // spilling off (`maxSpillBytes: 0`), saying so is the difference between a
      // model re-running the command with a bigger ceiling and one hunting for a
      // file that was never written.
      const spills = [
        typeof value.stdoutSpillPath === 'string' ? `stdout: ${String(value.stdoutSpillPath)}` : '',
        typeof value.stderrSpillPath === 'string' ? `stderr: ${String(value.stderrSpillPath)}` : '',
      ].filter(entry => entry !== '')
      if (value.truncated === true) {
        lines.push(spills.length > 0
          ? `[output truncated; full output — ${spills.join(', ')}]`
          : '[output truncated; full output: (no spill file configured — raise maxSpillBytes, or ask for more with `maxBytes`)]')
      }
      const bits = [`status=${String(value.status)}`]
      if (typeof value.elevated === 'string') bits.push(`elevated=${String(value.elevated)}`)
      // A command left running has no exit code yet, and saying `exit=null` reads
      // like a result rather than like a promise about the future.
      if (typeof value.jobId !== 'string') bits.push(`exit=${String(value.exitCode ?? 'null')}`)
      if (typeof value.durationMs === 'number') bits.push(`${String(value.durationMs)} ms`)
      if (value.truncated === true) bits.push('output truncated')
      lines.push(bits.join(' · '))
      // A producer that left the explanation out still gets one: an unexplained
      // nonzero exit on a remote host is the least useful thing to show a model.
      const message = typeof value.message === 'string' ? value.message : (value.ok === true ? undefined : runHint(String(value.status), typeof value.stderr === 'string' ? value.stderr : undefined))
      if (message !== undefined) lines.push(message)
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      return lines.join('\n')
    }
    case 'read': {
      // A directory answer and a file answer share one action, so the body picks
      // its shape from what the server said the path was.
      if (value.type === 'directory' || value.type === 'other' || typeof value.entriesText === 'string') {
        lines.push(`${where}: ls ${String(value.path)}`)
        const text = typeof value.entriesText === 'string' ? value.entriesText.trim() : ''
        lines.push(text === '' ? '(no entries)' : text)
        if (typeof value.message === 'string') lines.push(String(value.message))
        if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
        return lines.join('\n')
      }
      const content = typeof value.content === 'string' ? value.content : ''
      const clipped = value.truncated === true
        ? `, truncated${typeof value.size === 'number' ? ` of a ${String(value.size)} byte file` : ''}${typeof value.stdoutSpillPath === 'string' ? `; the whole stream is in ${String(value.stdoutSpillPath)}` : ''}`
        : ''
      lines.push(`${where}: ${String(value.path)} (${String(value.lines ?? 0)} lines, ${String(value.bytes ?? 0)} bytes${clipped})`)
      lines.push(content.replace(/\n$/u, ''))
      if (typeof value.message === 'string') lines.push(String(value.message))
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      return lines.join('\n')
    }
    case 'upload':
    case 'download': {
      // A refusal that never reached a target has no host to name, so the line
      // drops the preposition rather than inventing "the selected target".
      const known = value.target !== undefined || args.target !== undefined
      const head = known ? `${String(value.action)} ${value.action === 'upload' ? 'up to' : 'down from'} ${where}` : String(value.action)
      lines.push(`${head}: ${String(value.localPath)} <-> ${String(value.remotePath)}`)
      if (typeof value.bytes === 'number') lines.push(`${String(value.bytes)} bytes${value.recursive === true ? ' (directory)' : ''}`)
      else if (value.recursive === true) lines.push('directory')
      if (value.overwrote === true) lines.push('an existing destination was replaced')
      if (typeof value.message === 'string') lines.push(String(value.message))
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      lines.push(`status=${String(value.status)}${typeof value.durationMs === 'number' ? ` · ${String(value.durationMs)} ms` : ''}`)
      return lines.join('\n')
    }
    case 'edit': {
      lines.push(`${where}: edit ${String(value.path)}`)
      if (value.ok === true && typeof value.replaced === 'number') {
        const places = value.replaced === 1 ? '1 place' : `${String(value.replaced)} places`
        lines.push(typeof value.bytesBefore === 'number' && typeof value.bytesAfter === 'number'
          ? `replaced ${places}, ${String(value.bytesBefore)} -> ${String(value.bytesAfter)} bytes${typeof value.backup === 'string' ? ` (backup: ${String(value.backup)})` : ''}`
          : `replaced ${places}`)
      } else if (typeof value.matches === 'number') {
        // A refusal counts matches, not changes: nothing was written.
        lines.push(`matched ${String(value.matches)} times, so nothing was written`)
      }
      if (typeof value.message === 'string') lines.push(String(value.message))
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      if (value.ok !== true || typeof value.status === 'string') lines.push(`status=${String(value.status)}${typeof value.durationMs === 'number' ? ` · ${String(value.durationMs)} ms` : ''}`)
      return lines.join('\n')
    }
    case 'write': {
      const verb = value.overwrote === true ? 'replaced' : 'wrote'
      lines.push(`${where}: ${verb} ${String(value.path)} (${String(value.bytes ?? 0)} bytes)`)
      if (typeof value.message === 'string') lines.push(String(value.message))
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      return lines.join('\n')
    }
    default:
      return JSON.stringify(value).slice(0, 2000)
  }
}

/**
 * Register the tool and its policy gate, both as effects of the calling context.
 *
 * The tool name is a shared extension point: a duplicate within one layer throws,
 * so the registration falls back to a namespaced name rather than taking the
 * plugin down with another bundle's choice.
 * @param ctx - the Host plugin context, carrying `tools`.
 * @param deps - the wired dependencies.
 * @returns the registered name and a disposer for both registrations.
 */
/**
 * A live `remote` registration. Re-registering is how the alias list the model
 * chooses between stays honest: the parameter DSL freezes its strings at
 * `defineTool` time, so a changed inventory means disposing this handle and
 * claiming the name again with the new text.
 */
export interface RemoteToolHandle {
  /** The name the tool was registered under. */
  name: string
  /** Undo the tool and gate registrations. Calling it twice is a no-op. */
  dispose(): void
}

export function registerRemoteTool(ctx: Context, deps: RemoteToolDeps): RemoteToolHandle {
  const disposers: Array<() => void> = [
    ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== REMOTE_TOOL_NAME && exec.name !== REMOTE_TOOL_FALLBACK_NAME) return next()
      return gateRemoteCall(deps, exec, next)
    }), 'ssh: remote policy gate'),
  ]

  // The tool name is a shared extension point, so the registry is asked before it
  // is claimed: probing beats relying on how a duplicate error surfaces.
  const taken = (name: string): boolean => {
    try {
      return (ctx.tools as unknown as { get?: (name: string) => unknown }).get?.(name) !== undefined
    } catch {
      return false
    }
  }
  let chosen = taken(REMOTE_TOOL_NAME) ? REMOTE_TOOL_FALLBACK_NAME : REMOTE_TOOL_NAME
  if (chosen !== REMOTE_TOOL_NAME) {
    ctx.logger.warn(`ssh: another plugin already registers the "${REMOTE_TOOL_NAME}" tool, so this one uses "${REMOTE_TOOL_FALLBACK_NAME}"`)
  }
  const definition = buildRemoteTool(deps)
  const claim = (name: string): void => {
    disposers.push(ctx.effect(
      () => ctx.tools.register(name === REMOTE_TOOL_NAME ? definition : { ...definition, name }),
      `ssh: ${name} tool`,
    ))
  }
  try {
    claim(chosen)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (chosen !== REMOTE_TOOL_NAME || !/already registered/u.test(message)) throw error
    // Another plugin claimed the name between the probe and the registration:
    // fall back once rather than lose the capability to a race.
    ctx.logger.warn(`ssh: the "${REMOTE_TOOL_NAME}" tool was taken at registration, so this one uses "${REMOTE_TOOL_FALLBACK_NAME}" (${message})`)
    chosen = REMOTE_TOOL_FALLBACK_NAME
    claim(chosen)
  }
  let released = false
  return {
    name: chosen,
    dispose(): void {
      if (released) return
      released = true
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
}
