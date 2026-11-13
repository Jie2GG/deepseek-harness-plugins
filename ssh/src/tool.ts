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
import { leadingProgram } from './transport.ts'
import type { Ops, Params, RemoteFileResult } from './ops.ts'

/** Actions the tool offers in 0.6.0; file transfer joins in the next stage. */
export const REMOTE_TOOL_ACTIONS = ['targets', 'run', 'ls', 'read', 'write', 'upload', 'download'] as const

/** Preferred tool name, with a namespaced fallback if another plugin holds it. */
export const REMOTE_TOOL_NAME = 'remote'
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
  /** The conversation workspace one transfer call may touch. */
  local?: RemoteLocalBridge | undefined
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
}

/** One tool call's parameters as the registry decoded them. */
export interface RemoteCallArgs {
  action: (typeof REMOTE_TOOL_ACTIONS)[number]
  command?: string | undefined
  target?: string | undefined
  path?: string | undefined
  content?: string | undefined
  overwrite?: boolean | undefined
  append?: boolean | undefined
  mkdir?: boolean | undefined
  recursive?: boolean | undefined
  timeoutMs?: number | undefined
  maxBytes?: number | undefined
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
  const action = typeof raw.action === 'string' ? (raw.action as (typeof REMOTE_TOOL_ACTIONS)[number]) : 'run'
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
  if (args.action === 'targets') return { verdict: 'allow', reason: '' }
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
  if (args.action === 'ls' || args.action === 'read') {
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
  const command = (args.command ?? '').trim()
  const program = leadingProgram(command)
  if (program !== undefined && target.allowedCommands.includes(program)) {
    return { verdict: 'allow', reason: '' }
  }
  const why = program === undefined
    ? 'the command chains, redirects, or substitutes, so its effect is not one plain program'
    : `"${program}" is not in this target's allowlist`
  return {
    verdict: 'ask',
    reason: `Run on ${authority}: ${command.slice(0, 300)}`,
    display: {
      en: `Run a command on ${authority} — ${command.slice(0, 400)} — because ${why}.`,
      zh: `将在 ${authority} 上执行命令：${command.slice(0, 400)}（原因：${program === undefined ? '这条命令有串接、重定向或替换，不是单个程序' : `「${program}」不在该目标的白名单里`}）。`,
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
  allowedCommands: { type: 'array', items: { type: 'string' } },
  hasPassword: { type: 'boolean' },
  hasPassphrase: { type: 'boolean' },
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
 * Build the tool definition over the wired dependencies.
 * @param deps - the operations, the catalog reader, and the session hook.
 * @returns the definition the plugin registers.
 */
export function buildRemoteTool(deps: RemoteToolDeps): ToolDefinition {
  return defineTool({
    name: REMOTE_TOOL_NAME,
    description: 'Run commands and move files on an SSH server this plugin has stored, using the credentials saved with it. A call addresses one target: pass `target` (its id, display name, or host), or leave it out to use the target chosen for this conversation. Nothing is interpreted by a local shell; the remote command string is executed by the login shell on the server. `ls` and `read` are reads, while `run` and `write` may be refused by the user, and `run` needs the program to be allowlisted on the target to skip asking. The settings page is Settings → Remote connections.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...REMOTE_TOOL_ACTIONS],
        description: 'What to do: `targets` lists what is saved; `run` executes one command; `ls` lists a remote path; `read` returns a remote file as text; `write` sends text to a remote path.',
      },
      target: { type: 'string', description: 'Which saved target to use: its id, its display name, or its host (optionally `user@host`). Omit it to use the target chosen for this conversation.' },
      command: { type: 'string', description: 'For `run`: the command line to execute on the server, as one string. Quote anything that must survive the remote shell.' },
      path: { type: 'string', description: 'For `ls`, `read`, `write`: an absolute remote path, or one starting with `~/`. Shell metacharacters are refused.' },
      content: { type: 'string', description: 'For `write`: the exact text to put in the remote file; it is sent on stdin, never as an argument.' },
      overwrite: { type: 'boolean', description: 'For `write`: replace an existing remote file instead of refusing.' },
      append: { type: 'boolean', description: 'For `write`: append to the remote file instead of replacing it.' },
      mkdir: { type: 'boolean', description: 'For `write`: create the parent directory first. Defaults to true.' },
      localPath: { type: 'string', description: 'For `upload` and `download`: the path on this machine. Relative paths are resolved inside the conversation workspace, and a path outside it is refused.' },
      recursive: { type: 'boolean', description: 'For `upload` and `download`: move a directory rather than one file.' },
      timeoutMs: { type: 'integer', description: 'For `run`: override the command deadline for this call, in milliseconds.' },
      maxBytes: { type: 'integer', description: 'For `run` and `read`: the largest amount of output to bring back.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', enum: ['upload', 'download'], required: true }, localPath: { type: 'string' }, remotePath: { type: 'string' }, bytes: { type: 'integer' }, recursive: { type: 'boolean' }, overwrote: { type: 'boolean' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'targets', required: true }, targets: { type: 'array', items: { type: 'object', properties: TARGET_SHAPE, additionalProperties: false } }, count: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'run', required: true }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, stdout: { type: 'string' }, stderr: { type: 'string' }, truncated: { type: 'boolean' }, durationMs: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'list', required: true }, path: { type: 'string' }, entriesText: { type: 'string' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, durationMs: { type: 'integer' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { ...OUTCOME_SHAPE, action: { type: 'string', const: 'read', required: true }, path: { type: 'string' }, content: { type: 'string' }, bytes: { type: 'integer' }, lines: { type: 'integer' }, truncated: { type: 'boolean' }, durationMs: { type: 'integer' } },
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
        const target = payload.target as { id?: string; label?: string; host?: string } | undefined
        return {
          action: typeof payload.action === 'string' ? payload.action : 'run',
          ok: payload.ok === true,
          label: target?.label ?? target?.host ?? '',
        }
      },
    },
    timeoutMs: 300_000,
    presentCall: (args) => {
      const call = args as RemoteCallArgs
      const label = call.command !== undefined ? call.command : call.path ?? call.action
      return { card: 'generic', title: `remote ${call.action}`, kind: call.action === 'run' ? 'execute' : call.action === 'write' ? 'edit' : 'read', rawInput: String(label).slice(0, 400) }
    },
    async execute(args, exec) {
      const call = args as RemoteCallArgs
      const operations = await deps.ops()
      const params: Params = {}
      if (call.target !== undefined) params.target = call.target
      const sessionId = deps.sessionOf?.(exec)
      if (sessionId !== undefined) params.sessionId = sessionId
      switch (call.action) {
        case 'targets': {
          const listed = await operations.list()
          return listedResult(listed.connections, listed.settings) as never
        }
        case 'run': {
          if (call.command === undefined || call.command.trim() === '') {
            return { action: 'run', ok: false, status: 'failed', message: 'A run call needs a command.', hint: 'Pass command, as one string.' } as never
          }
          params.command = call.command
          if (call.timeoutMs !== undefined) params.timeoutMs = call.timeoutMs
          if (call.maxBytes !== undefined) params.maxOutputBytes = call.maxBytes
          const result = await operations.runCommand(params)
          return runResult(result) as never
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
          if (bridge !== undefined && dir !== undefined) {
            let local: string
            try {
              local = bridge.resolve(call.localPath, dir)
            } catch (error: unknown) {
              return { action: call.action, ok: false, status: 'failed', localPath: call.localPath, remotePath: call.path, message: error instanceof Error ? error.message : String(error), hint: 'Use a path inside the conversation workspace.' } as never
            }
            params.localPath = local
          } else {
            params.localPath = call.localPath
          }
          params.path = call.path
          if (call.overwrite === true) params.overwrite = true
          if (call.recursive === true) params.recursive = true
          if (call.maxBytes !== undefined) params.maxBytes = call.maxBytes
          const result = call.action === 'upload' ? await operations.upload(params) : await operations.download(params)
          return { ...result, action: call.action } as never
        }
        case 'ls':
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
          const result: RemoteFileResult = call.action === 'ls'
            ? await operations.listRemote(params)
            : call.action === 'read'
              ? await operations.readRemote(params)
              : await operations.writeRemote(params)
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
function listedResult(connections: Awaited<ReturnType<Ops['list']>>['connections'], settings: Awaited<ReturnType<Ops['list']>>['settings']): Record<string, unknown> {
  return {
    action: 'targets',
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
      ...(row.allowedCommands === undefined ? {} : { allowedCommands: [...row.allowedCommands] }),
      hasPassword: row.secrets?.password === true,
      hasPassphrase: row.secrets?.passphrase === true,
      ...(row.lastProbe === undefined ? {} : { lastProbe: `${row.lastProbe.status} at ${row.lastProbe.at}` }),
    })),
    message: connections.length === 0
      ? 'No SSH target is saved yet. Add one under Settings → Remote connections, then choose it for this conversation.'
      : `Default ceilings: command ${String(settings.remoteTimeoutMs)} ms, output ${String(settings.maxOutputBytes)} bytes, transfer ${String(settings.maxTransferBytes)} bytes.`,
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
    action: 'run',
    ok: !failed,
    status: run.status,
    ...(target === undefined ? {} : { target }),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.stdout === undefined ? {} : { stdout: run.stdout }),
    ...(run.stderr === undefined ? {} : { stderr: run.stderr }),
    ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(failed ? { message: runHint(run.status, run.stderr) } : {}),
    ...(failed && run.status === 'auth-failed' ? { hint: 'Check the stored password, or switch the target to a key its agent already holds.' } : {}),
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
      return 'The ssh executable named in Settings → Remote connections could not be resolved.'
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
    case 'targets': {
      const rows = Array.isArray(value.targets) ? (value.targets as Record<string, unknown>[]) : []
      if (rows.length === 0) return String(value.message ?? 'No SSH target is saved yet.')
      lines.push(`Saved SSH targets (${String(rows.length)}):`)
      for (const row of rows) {
        const authority = `${typeof row.user === 'string' ? `${row.user}@` : ''}${String(row.host)}`
        const bits = [
          String(row.label),
          authority,
          `auth=${String(row.auth ?? 'key')}`,
          row.agentAccess === 'off' ? 'agent off' : 'agent on',
          Array.isArray(row.allowedCommands) && row.allowedCommands.length > 0 ? `allowlist=${row.allowedCommands.join(',')}` : 'allowlist=none(ask every command)',
          row.hasPassword === true ? 'password stored' : '',
          row.hasPassphrase === true ? 'passphrase stored' : '',
          typeof row.lastProbe === 'string' ? `last probe: ${row.lastProbe}` : '',
        ].filter(Boolean)
        lines.push(`- ${bits.join(' · ')}`)
      }
      if (typeof value.message === 'string') lines.push(value.message)
      return lines.join('\n')
    }
    case 'run': {
      const command = typeof args.command === 'string' ? args.command : ''
      lines.push(`${where}$ ${command}`)
      const stdout = typeof value.stdout === 'string' ? value.stdout : ''
      const stderr = typeof value.stderr === 'string' ? value.stderr : ''
      if (stdout !== '') lines.push(stdout.replace(/\n$/u, ''))
      if (stderr !== '') lines.push(`[stderr] ${stderr.replace(/\n$/u, '')}`)
      const bits = [`status=${String(value.status)}`, `exit=${String(value.exitCode ?? 'null')}`]
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
    case 'list': {
      lines.push(`${where}: ls ${String(value.path)}`)
      const text = typeof value.entriesText === 'string' ? value.entriesText.trim() : ''
      if (text === '') lines.push('(no output)')
      else lines.push(text)
      if (typeof value.message === 'string') lines.push(String(value.message))
      return lines.join('\n')
    }
    case 'read': {
      const content = typeof value.content === 'string' ? value.content : ''
      lines.push(`${where}: ${String(value.path)} (${String(value.lines ?? 0)} lines, ${String(value.bytes ?? 0)} bytes${value.truncated === true ? ', truncated' : ''})`)
      lines.push(content.replace(/\n$/u, ''))
      if (typeof value.message === 'string') lines.push(String(value.message))
      return lines.join('\n')
    }
    case 'upload':
    case 'download': {
      // A refusal that never reached a target has no host to name, so the line
      // drops the preposition rather than inventing "the selected target".
      const known = value.target !== undefined || args.target !== undefined
      const head = known ? `${String(value.action)} ${value.action === 'upload' ? 'up to' : 'down from'} ${where}` : String(value.action)
      lines.push(`${head}: ${String(value.localPath)} <-> ${String(value.remotePath)}`)
      if (typeof value.bytes === 'number') lines.push(`${String(value.bytes)} bytes${value.recursive === true ? ' (directory)' : ''}${value.overwrote === true ? ', replaced an existing file' : ''}`)
      if (typeof value.message === 'string') lines.push(String(value.message))
      if (typeof value.hint === 'string') lines.push(`hint: ${String(value.hint)}`)
      lines.push(`status=${String(value.status)}${typeof value.durationMs === 'number' ? ` · ${String(value.durationMs)} ms` : ''}`)
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
 * @returns the name the tool was registered under.
 */
export function registerRemoteTool(ctx: Context, deps: RemoteToolDeps): string {
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== REMOTE_TOOL_NAME && exec.name !== REMOTE_TOOL_FALLBACK_NAME) return next()
    return gateRemoteCall(deps, exec, next)
  }), 'ssh: remote policy gate')

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
  const payload = chosen === REMOTE_TOOL_NAME ? definition : { ...definition, name: chosen }
  try {
    ctx.effect(() => ctx.tools.register(payload), `ssh: ${chosen} tool`)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (chosen !== REMOTE_TOOL_NAME || !/already registered/u.test(message)) throw error
    // Another plugin claimed the name between the probe and the registration:
    // fall back once rather than lose the capability to a race.
    ctx.logger.warn(`ssh: the "${REMOTE_TOOL_NAME}" tool was taken at registration, so this one uses "${REMOTE_TOOL_FALLBACK_NAME}" (${message})`)
    chosen = REMOTE_TOOL_FALLBACK_NAME
    ctx.effect(() => ctx.tools.register({ ...definition, name: chosen }), `ssh: ${chosen} tool`)
  }
  return chosen
}
