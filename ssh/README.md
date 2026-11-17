# @jie2gg/dsh-plugin-ssh

Manage the SSH targets this machine reaches from the Harness settings panel: a
named inventory written in one address field, two authentication modes (key or
password) whose secrets live in the credential store, and the connectivity probes
and client settings that use them. The same operations reach a conversation
through one agent tool, `ssh_client`, which runs under the policy gate described
below. User-facing wording lives
in [docs/DETAIL.md](docs/DETAIL.md) (and
[docs/DETAIL.zh.md](docs/DETAIL.zh.md) for Chinese).

## Layout

```
ssh/
├── package.json              # bundle manifest: dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # inserts one Host plugin row: id `ssh`
├── tsconfig.json             # NodeNext ESM, src/ → lib/, type-only client imports
├── icon.svg                  # original artwork (prompt caret + dashed link + server rack)
├── scripts/finalize-client.mjs  # strips TS's `export {};` and proves the script form
├── docs/DETAIL.md            # plugin detail page, English
├── docs/DETAIL.zh.md         # plugin detail page, Chinese
├── locale/en.json            # meta.title / meta.description / meta.detail
├── locale/zh.json            # same, Chinese; its meta.detail names DETAIL.zh.md
├── tests/                    # the offline suites: plain node:test against lib/ — build first
│   ├── helpers.mjs           # fake transport, store, secrets; the payload-schema checker
│   ├── tool.test.mjs         # gate, resolution, arguments, wording, every payload vs the schema
│   ├── ops.test.mjs          # every operation at its transport seam, marker protocol included
│   ├── storage.test.mjs      # the zod bounds and the strict records
│   ├── transport.test.mjs    # quoting, program extraction, the fingerprint tables, the sharing flags
│   ├── pool.test.mjs         # the master ledger: what a socket is named by, who is evicted, what gets closed
│   ├── jobs.test.mjs         # the background-job lifecycle and its outcome classes
│   ├── edit.test.mjs         # the exact-match rules, refusal by counted occurrence
│   ├── local-path.test.mjs   # the workspace boundary a transfer obeys
│   └── rpc.test.mjs          # method allowlisting and the failure-code-to-status map
└── src/
    ├── index.ts              # Host entry: name, inject, apply (domain open + route)
    ├── types.ts              # route path, method list, failure codes (client type-only)
    ├── storage.ts            # the `ssh_targets` domain: zod schemas, bounds, limits
    ├── store.ts              # typed reads/writes over the opened domain
    ├── transport.ts          # SshTransport: one option set, one child, run + probe, one lease
    ├── pool.ts               # MuxPool: the per-target shared connections and their ledger
    ├── secrets.ts            # password and passphrase records in the credential store
    ├── askpass.ts            # the private helper that answers an ssh prompt
    ├── tool.ts               # the agent-facing `ssh_client` tool and its policy gate
    ├── transfer.ts           # scp moves, pre-checked at both ends; downloads land by rename
    ├── local-path.ts         # the workspace boundary a local transfer path obeys
    ├── edit.ts               # the pure match-and-replace rules behind `edit`
    ├── jobs.ts               # a backgrounded remote command on the harness job registry
    ├── ops.ts                # every capability in one transport-agnostic object; the page and the tool share it
    ├── rpc.ts                # Request → Response, failure code → HTTP status
    ├── client.ts             # browser half: the page, its tabs, and its icon
    └── client-globals.d.ts   # ambient window/navigator; never emitted to lib/
```

## Build and install

`lib/` is git-ignored, so build before installing from the directory. DSH
resolves the `@deepseek-ai/*` peers from its own installation; `zod` and
`@deepseek-ai/dsh-storage-domain` ship as real dependencies because the Host
half imports them at runtime.

```sh
cd ssh
pnpm install        # dependencies + the type-only peers
pnpm run check      # tsc --noEmit
pnpm run build      # tsc, then finalize lib/client.js as a classic script
pnpm test           # build, then node --test tests/*.test.mjs (the offline suites)
# Lint with the harness checkout's oxlint when it is near; it is the cheapest
# check for the dead code a type pass leaves behind:
#   /data/deepseek-harness/node_modules/.bin/oxlint src tests scripts
```

The finalize step is not decorative: the web module table runs `lib/client.js`
as a script, so it must carry exactly one `window.__ModuleLoader__.load(` call
and no top-level `import`/`export`. `pnpm run build` fails if either half of
that is wrong.

Then in a running Harness: `plugin_manager` → `install_bundle` with the absolute
path of this directory. Acceptance per the repository rules: no manifest
diagnostics, and the title, description, icon, and detail document render in both
English and Chinese; the settings navigation shows one **Remote connections** /
「远程连接」 row with its icon, and the page opens on the **SSH targets** tab with
**Client settings** beside it. A freshly installed bundle's client artifact needs
the page to (re)load it: the open page follows the Host module graph over HMR, so
a rebuilt bundle for an installed row is usually swapped in without a manual
refresh — but a replaced package (not a rebuilt one) needs a restart to load a
fresh module generation.

## API

### Host (`src/index.ts`)

| Export | Shape | Notes |
| --- | --- | --- |
| `name` | `'ssh'` | Cordis plugin name for loader diagnostics. |
| `inject` | `['connection', 'subprocess', 'storageDomain', 'credentials']` | Hard requirements: without them the row stays inactive rather than throwing. |
| `apply(ctx, config)` | `(ctx: Context, config: SshConfig) => void` | Opens the domain, then registers `/api/ssh/rpc` inside `ctx.effect`; both disposers run on unload. |

The plugin declares a `Config` (`src/config.ts`) for its ceilings: a default and a
cap per ceiling, every one `.volatile()`, so editing the row's `config:` changes
what the next call resolves against without a restart and without touching the
storage domain. What the page edits stays in the domain (target list, overrides,
conversation choices), and the credentials stay in the credential store — so
saving from the page still never rewrites the profile patch file or restarts the
plugin.

### Route (`POST` and `GET` on `/api/ssh/rpc`)

Body `{ method, params? }`, result `{ ok: true, result }` or
`{ ok: false, error: { code, message, field?, hint? } }`. Codes are a closed set:
`bad-input` 400, `not-found` 404, `busy` 409, `storage-error` 500,
`secret-error` 500, `internal` 500.

| Method | Params | Returns |
| --- | --- | --- |
| `list` | – | `{ connections, settings, limits, askpass, askpassFailure?, probing }` |
| `save` | `{ connection, secrets? }` (no `id` = create) | `{ connection, connections }` |
| `remove` | `{ id }` | `{ removed, orphanSecrets, connections }` |
| `probe` | `{ id }` or `{ draft, secrets? }` | `{ connection?, probe?, connections }` |
| `resolve` | `{ target?, sessionId? }` | `{ action: 'resolve', ok, target, resolved, stored, differs, text? }` |
| `probeAll` | – | `{ connections, probed, skipped, failures }` |
| `configUpdate` | `{ settings }` | `{ settings }` |

The allowlist is the page's surface, not the operations surface: `runCommand`,
`upload`, `download`, and the session-target setters live on the same `ops`
object the agent tool drives directly, and since 0.0.32 the five entries no
control ever invokes are refused at the gate like any unknown name (the
`ops` methods themselves remain).

`GET` reaches only `list`; the route rides the shared `/api` channel, so only the
owner peer of the served page is admitted and every other principal is refused.

A connection row is `{ id, label, host, user?, port?, identityFile?, proxyJump?,
extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth }` plus
`secrets: { password, passphrase, root }`. `auth` is `key` or `password` on write;
`key+password` is still read (it was offered in 0.4.0 only) and probes as it
always did. `secrets` is presence only — no response ever carries a stored value,
and a `secrets` patch writes a string, forgets a `null`, and leaves an absent key
alone. `limits` carries the fixed bounds including the accepted ranges, so the
settings tab states them without mirroring them in browser code. Failure codes now
include `secret-error` (500).

### Storage

One domain, `ssh_targets` (`version: 4`, reading `version: 1` through `3` records
through `compatibleVersions`), on the backend the profile routes for
it — the `json` backend writes one document per unit, at
`$DSH_HOME/storages/ssh_targets.json`:

- table `connections`: `{ id, label, host, user?, port?, identityFile?, proxyJump?, extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth, agentAccess, allowedCommands, remoteTimeoutMs?, maxOutputBytes? }`, validated by zod on every read and write, so a hand-edited file cannot smuggle a bad record into the page (it surfaces as `storage-error` instead).
- table `sessions`: `{ sessionId, targetId, setAt }` — the target one conversation
  picked, so a remote call can omit `target`. `remove` clears the rows that point
  at a deleted target.
- global slot: `{ maxOutputBytes, remoteTimeoutMs, maxTransferBytes }`. A slot
  written before 0.0.18 also carries `command` and `probeTimeoutMs`; the schema
  accepts and ignores them, and the next save drops them.

Format history: 1 = targets only, 2 = added `auth`, 3 = added the agent fields and
the `sessions` table, 4 = the global slot shrank to the three ceilings. Every
added field is optional with a default that reproduces what the earlier version
meant, every retired field is accepted and ignored, so an existing file keeps
opening — and the `json` backend stamps the unit with the version it last wrote.

The file's shape, asserted by an integration run against the published json
backend:

```json
{ "unit": { "name": "ssh_targets", "version": 6 },
  "global": { "maxOutputBytes": 65536, "remoteTimeoutMs": 30000, "maxTransferBytes": 33554432 },
  "tables": { "connections": { "ssh-0123456789": { "id": "…", "label": "…", "host": "…", "auth": "password", "agentAccess": "on", "pool": "on", "allowedCommands": ["git"], "extraArgs": ["-4"], "createdAt": "…", "updatedAt": "…", "lastProbe": { "status": "auth-failed" } } }, "sessions": { "session-77": { "sessionId": "session-77", "targetId": "ssh-0123456789", "setAt": "…" } } }
```

Bounds split in two since 0.0.24. The structural ones still live in
`src/storage.ts`: 64 targets, 16 concurrent remote operations shared by probes and
commands, 8 servers that may each hold one shared connection (`MAX_LIVE_MASTERS`)
before the idle longest-quiet one is retired, a five-minute idle timeout on a
master (`CONTROL_PERSIST_SECONDS`), 12 per `probeAll` round, text fed to a
command's stdin capped at 1,000,000 characters, a remote command line at 8,192,
and at most 32 allowlisted program names of 64 characters each. A backgrounded
command has no deadline of its own since 0.0.26 — `BACKGROUND_DEADLINE_MS` is
gone, and the job lives until it settles, is killed, loses its owner, or the Host
exits, holding one of the 16 operation slots the while. Of those 16, at most
`maxConcurrentTransfers` (default 2) may be held by file copies, so two large
transfers can never starve every command; a copy refused by that ceiling is told
which ceiling it hit. A transfer runs on its own clock —
`transferTimeoutMs` (default 5 minutes, capped at `maxTransferTimeoutMs`,
30 minutes) — never the command's 30 s, because a permitted copy over a slow
link legitimately runs for minutes, and `scp` itself has no size limit of its
own. The recursive upload's file-count and cumulative-size ceilings
(`maxTransferFiles`, `maxTransferTotalBytes`) are pre-checks at walk time. The
ceilings a reader or a call can move — command timeout, per-stream output,
transfer size, transfer deadline — plus the probe and pre-check deadlines, the
spill cap, the kill grace, the per-kind lane ceilings, and whether a timed-out
command is promoted, now live in `src/config.ts` as a default-and-cap pair (or a
plain bounded default) each, all `.volatile()`.

### Bounds resolution (`src/config.ts`, `src/bounds.ts`)

The plugin used to carry two-sided ranges (`1 s – 300 s`, `1 KiB – 4 MiB`,
`1 KiB – 512 MiB`) and **reject** a value outside them. The harness has no such
shape anywhere, and that was the argument for changing it:

- `bash-local` declares `timeoutMs` (default 120 s) and `maxTimeoutMs` (600 s) as
  **volatile config**, and its `resolve()` *clamps* an override rather than
  refusing it (`packages/shell/bash-local/src/index.ts:100-107,122-127`).
- The one rule a shell request enforces is "positive and finite":
  `clampTimeout(requested, def, max, name)` throws only on that, and otherwise
  returns `min(requested ?? def, max)` (`packages/util/timeout/src/index.ts:45-55`).
- The shell result **echoes the effective timeout** — `ShellRunResult.timeoutMs`,
  "after defaulting/capping" (`packages/shell/shell/src/types.ts:159-160`).
- `tool-jobs` caps a wait the same way, and refuses at **load time** when a cap is
  configured below its default (`packages/jobs/tool-jobs/src/index.ts:241-253`).

So `bounds.ts` is now the only place the layering is stated — **call → target →
profile override → configured default**, capped by `max*` — and it returns the
effective value plus a note per correction, which `stampCeilings` attaches to the
result (`timeoutMs`, `outputBytes`, `notes`; transfers add `bytesLimit` and echo
their own transfer deadline rather than the command's). A value
past the cap is no longer an error; a value that cannot mean a deadline (zero,
negative, non-finite) still is, and the hint says where the line now sits.
`readBounds` re-reads the volatile values per call — never snapshotted — so a
profile edit lands on the next call, and a cap configured below its default is
raised with a note rather than silently strangling the default.

One asymmetry the harness cannot absorb for us: this plugin declares a
`ToolDefinition.timeoutMs` (it did not before), and `guard/timeout-policy` reads
that declaration and **replaces whatever the tool returned** with
`Error: tool call timed out after <N>ms` when its own timer wins
(`packages/guard/timeout-policy/src/index.ts:57-79`). Declaring the same number as
the internal cap — which is what 0.0.23 shipped, both at 300 s — meant that race
was a coin toss. The declared budget is now derived
(`max(maxTimeoutMs, statTimeoutMs + maxTransferTimeoutMs) + graceMs + DRAIN_MS
+ 5 s` of slack — the longer of the two clocks a call can wait on) and a test
pins the inequality, so the plugin's own classified answer always wins on an
ordinary timeout. `bash` sidesteps the whole question by declaring no budget at all
(`packages/shell/tool-bash/src/index.ts:368-534`); a remote call that hangs with
nothing to time out on is the reason this plugin keeps one.

`ssh -G`, `ssh -O`, and the probe deadlines are deliberately outside the override
layers: the resolve view dials nothing, and a probe's budget is a rule for the
page rather than a number a call negotiates. Which program dials is not a bound at
all either: `SSH_EXECUTABLE` and `SSH_FALLBACK_PATHS` (and the same pair for scp)
are the auto-detection search.

Record format is `version: 6` with `compatibleVersions: [1, 2, 3, 4, 5]`.

The shared settings slot carries the three ceilings the page still edits.
Since 0.0.18 the ssh/scp programs are found at run time — bare name on `PATH`
first, then the usual install locations, first hit cached until unload, misses
re-tried — and one probe waits a fixed 30 seconds, so neither is stored or
edited any more. A `configUpdate` that still sends a retired field is refused
as `bad-input` rather than quietly dropped.

### Credentials

Passwords, key passphrases, and the root account's own password do not live in
the storage domain. `secrets.ts` keeps them as `grant` records in the credential
store — `credentialKey('ssh', '<target-id>-password')`, `…-passphrase`, and
since 0.0.20 `…-root` (the secret `su` elevation answers with), so
`$DSH_HOME/.credentials.yaml` under `records:` — written with `modifyRecord`,
removed with `deleteRecord` (deleting a target forgets all three slots), and
read back only when a probe or an elevated call needs a value. The seam's rules
that matter here: each key segment must match `^[a-z][a-z0-9-]*$` (which is why
target ids are `ssh-<10 hex>`), a mutate callback returns a promise, an empty
value is absent rather than blank, and the store file must carry no permission
bits outside its owner.

`askpass.ts` materializes the helper that lets `ssh` ask for one of those secrets
with no terminal: `mkdtemp($TMPDIR/dsh-ssh-askpass-)` at mode `0700`, one
`askpass.sh` at mode `0700`, removed by the plugin's disposer. It reads the
prompt text `ssh` passes as `$1` and answers from `DSH_SSH_ASKPASS_PASSPHRASE` or
`DSH_SSH_ASKPASS_PASSWORD`, falling back to whichever slot is filled.

### Connection pool (`src/pool.ts`)

`MuxPool` leases a shared OpenSSH connection per target, so several calls ride one
authenticated session instead of each paying for its own handshake and login. What
it decides, and why:

- **Naming.** `<muxdir>/<target id>-<10 hex>.sock`, where the digest covers the
  authority, port, jump host, identity file, extra flags, auth mode, and a hash of
  the secret the call actually holds. Two rules fall out of that one line: an
  edited target cannot inherit the master its predecessor left open (the name
  changes and the old master idles out on its own), and a draft probed with a
  second password cannot ride along on a master that authenticated with the first
  and report the wrong secret as good. The secret itself never appears in a name.
- **The default runs the other way.** `sshOptions` hands a call
  `ControlPath=none` unless its caller leased a socket first. The Host account's
  own `~/.ssh/config` may name a `ControlPath`, and a child that inherited it would
  be sharing a master nobody here is counting, on credentials nobody chose.
  `ControlMaster=no` alone would not be enough: it still joins a master that is
  already listening.
- **No probe on the hot path.** The ledger holds a *belief*. Nothing runs
  `ssh -O check` before a call, because `ControlMaster=auto` falls back to a fresh
  direct connection when the master has died — asking first would spend a whole
  process per call to learn something the child learns for free.
- **Settling a lease.** A call that reached a session marks the master live. A call
  that timed out, or printed one of `SESSION_SETUP_PATTERNS` (`session setup
  failed`, `too many sessions`, `channel open failed`, `ControlSocket … already
  exists`), drops it so the next call dials its own. A rejected credential or a
  refused host key settles nothing either way: the release path already discards a
  master that never proved itself.
- **Two ceilings, for two different costs.** `MAX_CONCURRENT_OPS` (16) counts local
  `ssh` children, which is what this machine pays for. `MAX_LIVE_MASTERS` (8)
  counts servers holding a shared connection; when a ninth arrives, the idle entry
  that has been quiet longest is retired with `ssh -O exit`, and when all eight are
  busy the newcomer dials alone rather than opening an unplanned session on some
  server. Teardown children take no operation slot: closing a socket is a local
  conversation, and it must still be possible while every slot is full.
- **The server has its own ceiling.** `sshd`'s `MaxSessions` (default 10) caps the
  channels one master may carry, and a host configured lower is a real case. That
  is what the per-target `pool: 'off'` switch is for: the page edits it under
  **Advanced options**, the model sees it as a `pool off` chip, and the record
  carries it as `pool`, which is why the domain went to version 5; version 6 made
  the global slot's three ceilings optional overrides of configured defaults.
- **`ssh -G` leases nothing.** The resolve view answers where an alias points;
  naming a control socket in it would describe a connection the call never makes.
- **A page probe warms the pool.** The settings test dials under the same lease an
  agent call takes, so pressing `Test` leaves behind the very connection the next
  command rides — which is also why the probe asks for `-N` on a leased call: it is
  the fastest way to answer "can this credential log in", and the cheapest.
- **Lifetime.** The socket directory is a `mkdtemp` 0700 tree under the system temp
  directory, made at activation and removed at unload, exactly like the askpass
  helper. A master is a process OpenSSH left in the background, not a child this
  Host still watches, so a Host killed outright leaves each master on its server
  until `CONTROL_PERSIST_SECONDS` (300) runs out.

### Promotion: a deadline that belongs to the reply

`ops.runPromoted` is the 0.0.26 shape of a foreground `exec`, and it copies the
harness's own answer rather than inventing one: the command is started through the
same untimed job-capable path a background call uses, and the plugin then **waits
on it** for `settings.remoteTimeoutMs` (`packages/shell/tool-bash/src/index.ts:508`
resolves with `onExpiry: 'none'` for exactly this reason, and `:297-353` waits the
registry out).

- Settled inside the window → classified normally, the way it always was.
- Still running at the deadline → `startRemoteJob` attaches the live child and the
  call answers `status: 'promoted'` with the `jobId`, the partial output, and a hint
  naming `job_output`. `ok` is true: the call succeeded at handing over, and a model
  that read it as a failure would restart a build that is still going.
- Refused by the registry (the per-owner job cap) → the child is killed and the
  result says the hand-over was refused and why, rather than pretending the timeout
  was the whole story.

Two details are load-bearing. The provider's offset readers are **non-consuming**,
so the partial read that comes with the hand-over does not steal bytes from the job
— verified live: the hand-over preview carried `first-line`, and `job_output`
afterwards carried `first-line`, `second-line`, and `exit=0 · 3377 ms`. A promoted
result therefore sets **no** `truncated` flag either: that word means a ceiling
clipped a finished stream, and here the stream is still being written — 0.0.26
claimed otherwise and the renderer went on to report a spill file that had never
been needed. And `startRun` gained `stdin`, because an elevated command's password
is injected at spawn: a promoted call has already answered its prompt, so handing it
over is safe in a way that *starting* a call in the background never is
(`background: true` with `as`/`su` stays refused).

`promoteOnTimeout: false` in config, or a profile with no job registry, keeps the
plain bounded wait — the behaviour this plugin shipped with, still one code path
rather than a special case.

### Tool (`src/tool.ts`)

One tool, `ssh_client`, registered through `ctx.tools.register(defineTool(…))` inside
`ctx.effect` — a third-party bundle needs no preset entry: the registry feeds its
schemas into the system-prompt assembly on its own (the installed `dsh-github-flow`
bundle is the live proof of that).

| Field | Shape |
| --- | --- |
| `action` | `get_connection` \| `exec` \| `read` \| `write` \| `edit` \| `upload` \| `download` — `exec` also takes `background: true` — `read` answers a directory listing, a file's text, or a refusal, depending on what the path is — `edit` also takes `dryRun: true` to preview the change and its diff without writing or backing anything up |
| `localPath`, `recursive` | the local side of a transfer; relative paths resolve inside the conversation workspace |
| `target` | id, display name (any case), `host`, or `user@host`; omitted means this conversation's chosen target, then a lone saved target |
| `command` / `path` / `content` | the remote command line, an absolute remote path, and the exact text to write |
| `background` | for `exec`: leave the command running and return its job id; poll with `job_output`, stop with `job_kill` |
| `tty` / `input` | for `exec`: run under `ssh -tt` (for a command that inspects its own output), and text fed to its stdin |
| `as` / `su` | for `exec`: elevation — `as: "<account>"` prefixes sudo (forcing `tty` and injecting the stored login password as the answer; `sudo -n` when no password is stored), `su: true` runs the command inside `su root -c` answered with the stored root password; an explicit `input` overrides either injection, and both never appear in results or transcripts |
| `localPath` / `recursive` | for `upload` and `download`: the workspace-side path, and whether a directory moves |
| `oldText` / `newText` | for `edit`: the exact text to find (copied from a read) and its replacement; an empty `newText` deletes |
| `all` / `replaceFirst` / `backup` | for `edit`: replace every occurrence / only the first / skip the `<path>.dsh-bak` copy |
| `overwrite` / `append` / `mkdir` | write behaviour; `mkdir` defaults to true |
| `timeoutMs` / `maxBytes` | per-call overrides of the shared ceilings |
| `output` | `oneOf` per action, each `additionalProperties: false`; `execute` returns the canonical value and `output.render` writes the transcript text. The registry validates that value against the projected schema, so a branch that omits a field the producer emits rejects the whole call — the suites therefore validate every action's payload with `validateJsonSchemaValue`, not just its contents |

Two notes on that field table, both pinned by `tests/tool.test.mjs`:

- Naming a target with an explicit `target` argument records it as this
  conversation's choice (`rememberSessionTarget` writes the `sessions` row only
  for a call that succeeded and named a server on purpose), so the next call can
  leave `target` out.
- The `parameters` schema now declares all twenty-three fields the body reads; until
  0.0.16 the seven the `edit` and prompt-answering calls use (`oldText`, `newText`,
  `all`, `replaceFirst`, `backup`, `tty`, `input`) arrived undeclared and survived
  only the defensive reader, 0.0.20 added `as`/`su` alongside them, and 0.0.32
  added `dryRun` for the `edit` preview.
- The tool declares `isConcurrencySafe` for the two reads only — `get_connection`
  and `read` — so the harness may run several of those in one parallel batch.
  Every action that changes something stays exclusive: the transport *could* run
  mutations concurrently, but no remote filesystem here makes read-modify-write
  transactional, and the declaration is about what is safe to interleave, not
  about what the plumbing survives.

Policy is decided in `tools/pre-execute`, not inside the tool, which is what the
tool-authoring docs prescribe for deployment policy:

| Call | Verdict |
| --- | --- |
| `get_connection`, `read` (a listing or a file's text), `download` | allow |
| `exec` carrying `as` or `su` | **ask, always** — sudo is a master key, and an allowlist hit on the inner program never consented to another account; the prompt names the account and which stored secret it will spend |
| `exec`, its one bare leading program is on a **non-empty** `allowedCommands` | allow — the same verdict applies to a backgrounded command |
| `exec`, any other command: an unlisted program, an **empty allowlist** (what a fresh target has, so every command is asked), or a pipeline / redirection / substitution (no single leading program) | **ask** |
| any `ask`, in a conversation whose approval policy is `never` (full-access mode) | **allow** — the core rejects unanswered asks by policy, so asking there is a self-inflicted refusal; this is consent the deployment stated on purpose |
| any `ask` whose approval surface is unreachable — no `approval` service mounted, or no session to route through (`unavailable`) | **ask**, and the core answers with its fail-closed denial that names the missing piece. Since 0.0.30 `unavailable` is no longer merged with `never`: the absence of anyone who could consent is not itself consent, and a remote write in a profile with no approval surface is refused rather than silently run |
| `write`, `edit`, `upload` | **ask** |
| `download` | allow (it reads the server and writes inside the session workspace, which the file pipeline already governs) |
| any action on a target with `agentAccess: off` | deny, naming the settings page |
| storage unreadable at gate time | deny — running blind on a remote host is worse |

This table states `decideAccess` as it runs today, and since 0.0.17 the
model-facing strings state it too: `describeRemote` tells the model a command
runs unasked only when its bare leading program is named by a non-empty
allowlist, and the `get_connection` render line prints `allowlist=none(ask
every command)` — both pinned by `tests/tool.test.mjs`, which asserts the
description and the gate agree on the same call. (`0.10.0` intended this; the
strings drifted at 3786005 and the gate never moved.)

Both switches are edited in the target form since 0.0.31: an **agent access**
checkbox (off shows an `agent access off` chip on the row) and a **no-approval
programs** field. The field is a no-approval list, not a sandbox and not a
limit: it only decides which single-program commands skip the asking, it does
not restrict what arguments a listed program receives, and it cannot make a
write safe. The page's own hint states the same.

An `ask` is resolved by the harness approval UI (`ctx.approval`, answered through
the standard tool-approval surface) with `displayReason` supplied in English and
Chinese, and a missing approval service turns an `ask` into a denial rather than a
pass. The tool body re-checks only the hard stop (`agentAccess`), because it
cannot know whether the gate already obtained consent.

The name `ssh_client` is a shared extension point: the registry is probed with
`ctx.tools.get` first, and a taken name falls back to `ssh_remote` with a warning
instead of failing the fiber; a race between probe and registration retries once.
An unrelated registration fault still propagates.

### Client (`src/client.ts`)

One component owns the page and its two tabs: `SshSection` holds the state, the
`list` read, and every operation, while `SshTabs` switches which cards render —
**SSH targets** (the list, the form, and the probe results) or **Client settings**
(the three fields plus the read-only fixed bounds). `apply` registers the
`settings.ssh` dictionaries (both baseline locales) and then two seats, each
inside its own `ctx.effect`:

| Seat | Registration | Renders |
| --- | --- | --- |
| `settings.section` | `{ id: 'ssh', order: 25, label: () => ctx.locale.bind(NS)('nav'), locale: NS }` | the page, including its tab strip |
| `settings.section.icon` | `{ id: 'ssh' }` | caret + dashed link + server rack, matching `icon.svg` |

The settings shell has no grouping mechanism for plugin sections — one section is
one navigation row — so two views under one row are the page's own tabs. The tab
strip is the host `SegmentedControl` copied into this module rather than
imported, which is what the plugin-UI rules require; see the vendoring note under
**Verified contracts** for the markup, keyboard, and token contract it carries.

Controls and their stylesheet are local to the plugin (`dshssh-*` classes,
`--dsw-alias-*` tokens only, no Harness client package required as a module), and
the stylesheet is rendered as a `<style>` element inside the component so
unmounting removes it.

## Verified contracts

Facts checked against the running DSH (`0.2.2-rc.1`, `web` profile) while 0.2.0
was written and re-checked through 0.5.1 (plugin numbers here are pre-rule; see
`CHANGELOG.md`), and reproduced against a live server for the 0.5.1 fix, so the
next round does not have to re-derive them:

- `ssh -G <target>` is a **local** operation: it prints the resolved
  configuration and exits without dialing, so the Resolve button cannot hang,
  cannot leak a credential, and answers the alias question instantly. The plugin
  passes only its own port/key/jump/extra-flag overrides, so what it prints is
  what a probe would dial.
- Connection sharing, reproduced against a live server (OpenSSH 10.0p2 client,
  `jiegg@10.100.1.1`) while 0.0.22 was written, so none of the pool rests on a
  reading of the manual: `-o ControlMaster=auto -o ControlPath=<literal path> -o
  ControlPersist=300` leaves the master **running after the first client exits** —
  the socket file is still there and `ssh -O check` answers `Master running
  (pid=…)` — a second call rides it, and `ssh -O exit` answers `Exit request
  sent.` *and removes the socket file*. A later `-O check` on that path fails with
  `Control socket connect(…): No such file or directory` and exit 255, while a
  fresh call on the same dead path authenticates again and exits 0. That last line
  is the whole reason the pool never probes liveness on the hot path: OpenSSH
  heals a dead master by dialing directly, for free, inside the call that needed
  it. A control socket named by a literal path (no `%h`/`%C` tokens) works for
  `-O` too, which is what makes an eviction targetable.
- **The subprocess provider already owns output retention; the plugin only had to
  ask.** A stream collect is `{ maxBytes, spill?: { maxBytes } }`, and "omitting
  `spill` keeps only the in-memory tail" is documented behaviour
  (`packages/subprocess/subprocess/src/types.ts:38-52`): with `spill` present, the
  provider keeps the **tail** in memory because "errors and final results cluster
  at the end", and writes the **complete** stream to a `0600` file under its own
  `mkdtemp` 0700 per-process directory (`packages/subprocess/subprocess-local/src/
  output.ts:126-128,160-213`), reporting the path as `spillPath` on the read. This
  plugin passed `maxBytes` alone until 0.0.25, which is why "truncated" used to mean
  "the rest is gone"; it now passes the spill budget too and carries the path into
  the result and the transcript, in the same sentence shape the bash tool uses
  (`packages/shell/tool-bash/src/render.ts:11-15`). A stream larger than the spill
  cap has the file discarded — the plugin does not pretend otherwise: it names what
  is absent rather than inventing a recovery.
- **`ssh -N` ends by itself when a master is being left behind** — measured on the
  same live server while 0.0.23 was written, which is what the probe is built on:
  with `-o ControlMaster=auto -o ControlPath=… -o ControlPersist=300`, an `-N` call
  authenticates and exits 0 in **0.2 s** for a first connection and **0.1 s** over
  a warm master, leaving `Master running (pid=…)` behind. Without those options the
  same `-N` call **hangs** (an idle session with nothing to do, killed only at its
  deadline) — hence the probe asks for `-N` only on a leased connection and runs
  `true` on its own. A rejected credential is still named honestly under `-N`
  (`Permission denied (publickey,password).`), while the same wrong password run
  with `true` printed `Connection closed by … port 22` and would have been
  classified `unreachable`: the older shape could blame the network for a secret
  problem. The `Authenticated to … using "password".` line exists in this client but
  is only printed at `LogLevel=VERBOSE`, where it drowns in the key-exchange
  transcript, so the probe reads the exit status instead of chasing it.
- `fs/write-intent` is a single-slot **decision** waterfall: a listener may
  answer `createIfAbsent` or `replaceIfVersion` and never consults your write, so
  the plugin must act on the answer — a create-only guard against an existing file
  is a refusal, and a version guard cannot be honoured by an external copy and is
  reported as such. The session change recorder attaches the edit by **object
  identity** of the actor it saw at `tools/pre-execute`, which is why the plugin
  hands the live tool execution to the waterfall and not a look-alike.
- File transfer: `scp` is the sibling of the **detected** ssh executable
  (`/usr/bin/ssh` → `/usr/bin/scp`, else its own `PATH`-then-locations search);
  it takes the port as `-P` (not `-p`), accepts
  the same `-o BatchMode` / `StrictHostKeyChecking=accept-new` / `-i` / `-J` /
  `PreferredAuthentications` flags, and reads the remote end as one `host:path`
  argument, so no local shell is involved and a path with spaces needs no quoting.
  Both directions name the far end `host:path` — a download that passed the bare
  remote path copied locally instead, which is what the first live check caught.
  A size and type pre-check (`stat -c '%s %F' -- '<path>'`, GNU coreutils here) runs
  before a download so an oversized or directory payload is refused without
  touching the disk, and a **upload** is pre-checked at both ends: the local
  file's existence, readability, and size — for a tree also the file count and
  cumulative bytes, walked with a symlink loop guard — and the remote
  destination, which is refused (`refused-exists`) unless `overwrite` says
  otherwise, because bare `scp` replaces a remote file without a word. A
  download never writes its final path directly: the bytes land in a unique
  `.dsh-part-<pid>-<entropy>` sibling that is renamed into place only after a
  clean finish, and cancelled, timed out, or failed copies delete the sibling
  instead of leaving a half file behind. Every one of these checks measures what
  `stat` said **before the copy started** — they are pre-checks, not gates on the
  bytes that move: a file that grows during a transfer can still push more
  through than the number quoted. `rsync` is absent on this machine and is
  therefore not used.
- Approval is two independent switches: the file sandbox (`read-only` /
  `workspace-write` / `danger-full-access`) governs writes, while
  `ApprovalPolicy = 'ask' | 'never'` governs whether a person is consulted at all.
  `'never'` is decided inside `ApprovalService.decide` **before** the
  `approval/request` waterfall is dispatched (`packages/interaction/user-approval`),
  so a plugin listener cannot rescue an ask there; the effective policy is
  `overrideOf(session) ?? config.policy ?? 'ask'`, both reachable on the public
  service surface, and `ctx.get('approval')` reads it without injecting.
- Claiming a `tool.call.toolview` key replaces the generic row **completely**: the owner
  must then cover every phase (`preparing` / `start` / `result`) and every action, with the
  seat's `useDisclosure`, `openFile`, `inspect`, `cwd`, and `home`, and with arguments read
  from `argsRaw` once sealed or from the lazy partial-JSON view while streaming (during
  render, never parked in state keyed by block identity). This plugin tried that and gave it
  up: owning the chrome bought nothing the rendered transcript text did not already say.

- A spawned child has **no terminal**: stdin is ignored, and the Host process is
  not attached to one. That makes the interactive host-key question unanswerable,
  which is the whole 0.5.1 fix — `accept-new` records instead of asking (OpenSSH
  7.6+, and this machine runs 10.0p2). A changed key still fails, and its
  `Offending … key in` / `Remote Host Identification Has Changed` output is
  classified as `unknown-host`.
- The collected streams are only complete after the provider has terminated the
  child and drained them, so a probe that hits its deadline waits up to 400 ms
  for `waitForExit` before reading them; without that drain a timeout carries no
  reason at all.
- One interrupted child, one cause. `#settleAndDrain` builds its wait with
  `deadline(external, timeoutMs, SSH_TIMEOUT)` from `@deepseek-ai/dsh-timeout`,
  which fuses the caller's signal and the plugin's timer through
  `AbortSignal.any` — the first aborter's reason is the one that survives, and
  `timeoutOf(signal, SSH_TIMEOUT)` reads ours only when the timer won. The
  hand-rolled version resolved `external?.aborted` inside the timer callback, so a
  child killed in the same instant as its deadline was reported as whichever branch
  the code happened to test first. A `timeout` now means the server was too slow,
  and a `cancelled` means the reader stopped it — never a coin toss between them.
  `timeoutMs: 0` means arm no timer, which is how a backgrounded or promoted job
  outlives the reply that started it. Since 0.0.30 every remote action forwards
  the tool call's own `exec.signal` down this chain — `exec`, `read`, `write`,
  `edit`, `upload`, `download` all end their local child when the conversation
  cancels the call or the declared call budget expires; the plumbing existed in
  the transport long before anything handed it a signal. The honest boundary:
  that kills the **local** ssh/scp process. Whether the server-side command dies
  with its channel is the server's choice, and this plugin does not claim
  otherwise.
- A probe reads that account's `~/.ssh`, not the terminal user's. `list` used to
  report `runsAs` (`uid`, `user`, `home`) so a settings card could name the
  account; the card was cut in 0.0.21 — the name settled nothing the probe
  result had not settled already, and its `user` was `process.env.USER`, a name
  inherited from whoever launched the process rather than what its uid proves.
  The facts that would actually settle it are the four the card never carried:
  the resolved `ssh` path, whether that account's agent holds any identity,
  whether the named key file is readable by it, and whether the host is already
  in that account's `known_hosts`.

## Remaining surface

The old four-item plan has landed: the agent tool (0.6.0), file transfer over the
same transport (0.9.0), and — through 0.15.0/0.16.0 — a pseudo-terminal, stdin
answers, and background jobs on the harness job registry; those are pre-rule
numbers, mapped in the versioning note at the top of `CHANGELOG.md`. What is
still open:

1. A terminal one can type into live: `tty` plus `input` answers a prompt, and
   `background: true` streams output out of band, but there is no interactive
   session.
2. Optional: read `~/.ssh/config` aliases as a suggested inventory (`ctx.fs`).
3. Tried and deliberately dropped: claiming the `tool.call.toolview` seat, so a
   remote call keeps rendering in the harness's generic tool row — see the note
   under **Verified contracts**.

## Limits of 0.0.33

- The settings page is inventory, probes, resolve, and ceilings only: running
  commands, editing files, and moving bytes reach the server through the
  conversation's `ssh_client` tool — the page has no run console, no transfer
  picker, and no job list.
- A probe reads the **Host account's** ssh world — its `~/.ssh/config`, keys,
  agent, and `known_hosts` — not the terminal user's, so a working alias in a
  shell can still resolve differently here. The first probe records an unknown
  host key rather than asking.
- Nothing about these fixes is live until the running Host loads the new module:
  an in-place package swap keeps the previous one until the process restarts.
- A page probe still authenticates and runs only `true`; real commands come from
  the agent's `exec` action.
- A foreground call is waited for. `tty: true` gives the command a pseudo-terminal
  (`ssh -tt`, with its stderr-merges-into-stdout and CRLF costs) and `input` feeds
  its stdin; `background: true` hands the command to the harness job registry — the
  call answers with a job id, output streams through `job_output` from the
  provider's own offsets, `job_kill` stops it, and the job holds one of the 16
  concurrent operation slots until it settles. Explicitly backgrounded jobs are
  capped at `maxRunningJobs` (default 8) of those slots — a reservation inside
  the existing lane counter, not a second scheduler — so even eight abandoned
  long-running commands cannot busy-lock the plugin against foreground work; a
  start refused by that ceiling names it and points at `job_kill`. A job arms no
  timer of its own: it ends when it settles, when someone kills it, when its
  conversation goes away, or when the Host exits — the same bargain the harness's
  own background shell makes. The connection lives in the Host process:
  stopping the job, ending the conversation, or restarting the Host ends the
  remote command, and `job_kill` interrupts the local client — whether the
  server-side process dies with the session is the server's choice. There is no
  terminal to type into live. Elevation (`as`/`su`) answers prompts through that
  same stdin, so it is a foreground-only feature: a backgrounded command with
  `as`/`su` is refused with a hint, and still works if the server runs NOPASSWD
  and the command says `sudo` itself.
- `edit` refuses a file larger than the read ceiling rather than replacing text it
  never saw, and `write` / `edit` / `upload` change the server in place: nothing
  there is versioned beyond the optional `<path>.dsh-bak` copy an `edit` takes.
  This is a preview-and-confirm flow, not a transaction: between an `edit`'s read
  and its `cat >` write a server-side change is overwritten without a version
  check, and a child killed mid-write leaves the file cut short — the undo is the
  backup, not a rollback. Since 0.0.32 `edit` takes `dryRun: true`: the match is
  counted and a line diff comes back, and nothing is written, backed up, or
  dialed beyond the read the preview needs anyway.
- The elevation prompt and an `input` body share the one stdin, and the prompt
  reads first: `su` with input is refused up front, and so is `as` with input
  whenever a login password is stored. The single coexistence that is real —
  `as` with no stored password, which runs `sudo -n` and so never prompts —
  keeps working: the body arrives intact on a NOPASSWD host and fails fast,
  with a reason, anywhere else.
- A named `identityFile` arrives with `-o IdentitiesOnly=yes`: without it, an
  ssh-agent holding several keys offers them first, and a server that counts
  attempts locks out the one key the reader named before it is ever tried. Name
  no key and nothing is added — the client's own defaults, agent included, stand
  — and `-o IdentitiesOnly=no` in the target's extra arguments still wins,
  because those land after the plugin's flags. The `ssh -G` resolve view carries
  the same pair, so the card shows what the children actually run.
- The local edge of a transfer is lexical: `localPath` is matched against the
  conversation's workspace directory by prefix, without resolving symlinks — a
  choice `src/local-path.ts` states out loud. A symlink planted inside the
  workspace therefore sends a download wherever that link points; the check
  keeps a model from typing arbitrary absolute paths, and it does not claim to
  confine inodes.
- A download dispatches `fs/write-intent` before `scp` runs, with the tool
  execution as the actor, which is how the external write still lands in the
  conversation's change summary (the recorder reads the before-image from that
  waterfall and compares the disk at turn end; it never watches the write). The
  plugin does not emit `fs/observed` afterwards — nothing needs it for the change
  list, and the version token belongs to whoever performs the write.
- The plugin claims the tool name `ssh_client`, falling back to `ssh_remote` when
  another bundle holds it, and does not claim the `tool.call.toolview` seat at all:
  a call renders in the harness's generic tool row like any other tool's.
- The credential store is private to other OS users, not to the agent: tool
  processes run as the same user that can read `.credentials.yaml`.
- Deleting the bundle leaves both `storages/ssh_targets.json` (targets, ceilings,
  and the per-conversation choices) and the plugin's `ssh/…` records in
  `.credentials.yaml` in place until you remove them.
- After an in-place package replacement the running Host keeps its previous module
  until restart. The page detects that (`list` reports no `askpass`) and hides the
  authentication controls with an explanation instead of sending a field the old
  module would reject.
- `private: true`: not published to npm while the status is `experimental`.

## License

Apache-2.0 — see [LICENSE](../LICENSE) at the repository root. The icon is
original artwork by this repository's maintainer under the same license: a
terminal caret linked by a dashed line to a server rack, not a third-party mark.
