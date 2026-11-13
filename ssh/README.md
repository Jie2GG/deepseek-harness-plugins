# @jie2gg/dsh-plugin-ssh

Manage the SSH targets this machine reaches from the Harness settings panel: a
named inventory written in one address field, two authentication modes (key or
password) whose secrets live in the credential store, and the connectivity probes
and client settings that use them. User-facing wording lives
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
└── src/
    ├── index.ts              # Host entry: name, inject, apply (domain open + route)
    ├── types.ts              # route path, method list, failure codes (client type-only)
    ├── storage.ts            # the `ssh_targets` domain: zod schemas, bounds, limits
    ├── store.ts              # typed reads/writes over the opened domain
    ├── transport.ts          # SshTransport: one option set, one child, run + probe
    ├── secrets.ts            # password and passphrase records in the credential store
    ├── askpass.ts            # the private helper that answers an ssh prompt
    ├── tool.ts               # the agent-facing `remote` tool and its policy gate
    ├── transfer.ts           # scp moves, with a remote size and type pre-check
    ├── local-path.ts         # the workspace boundary a local transfer path obeys
    ├── ops.ts                # one method per RPC name, transport-agnostic
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
| `apply(ctx)` | `(ctx: Context) => void` | Opens the domain, then registers `/api/ssh/rpc` inside `ctx.effect`; both disposers run on unload. |

No `Config` is declared: every editable value lives in the plugin's storage
domain, so the row's `config: {}` is accepted as-is and saving from the page
never rewrites the profile patch file or restarts the plugin.

### Route (`POST` and `GET` on `/api/ssh/rpc`)

Body `{ method, params? }`, result `{ ok: true, result }` or
`{ ok: false, error: { code, message, field?, hint? } }`. Codes are a closed set:
`bad-input` 400, `not-found` 404, `busy` 409, `storage-error` 500,
`internal` 500.

| Method | Params | Returns |
| --- | --- | --- |
| `list` | – | `{ connections, settings, limits, askpass, askpassFailure?, probing }` |
| `save` | `{ connection, secrets? }` (no `id` = create) | `{ connection, connections }` |
| `remove` | `{ id }` | `{ removed, orphanSecrets, connections }` |
| `probe` | `{ id }` or `{ draft, secrets? }` | `{ connection?, probe?, connections }` |
| `run` | `{ command, target?, sessionId?, timeoutMs?, maxOutputBytes? }` | `{ run, connection?, connections }` |
| `upload` / `download` | `{ path, localPath, localDir?, target?, sessionId?, recursive?, overwrite?, maxBytes?, timeoutMs? }` | the transfer result |
| `setSessionTarget` / `clearSessionTarget` | `{ sessionId, targetId? }` | `{ sessionTarget }` |
| `probeAll` | – | `{ connections, probed, skipped, failures }` |
| `configUpdate` | `{ settings }` | `{ settings }` |

`GET` reaches only `list`; the route rides the shared `/api` channel, so only the
owner peer of the served page is admitted and every other principal is refused.

A connection row is `{ id, label, host, user?, port?, identityFile?, proxyJump?,
extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth }` plus
`secrets: { password, passphrase }`. `auth` is `key` or `password` on write;
`key+password` is still read (it was offered in 0.4.0 only) and probes as it
always did. `secrets` is presence only — no response ever carries a stored value,
and a `secrets` patch writes a string, forgets a `null`, and leaves an absent key
alone. `limits` carries the fixed bounds including the accepted ranges, so the
settings tab states them without mirroring them in browser code. Failure codes now
include `secret-error` (500).

### Storage

One domain, `ssh_targets` (`version: 3`, reading `version: 1` and `2` records through
`compatibleVersions`), on the backend the profile routes for
it — the `json` backend writes one document per unit, at
`$DSH_HOME/storages/ssh_targets.json`:

- table `connections`: `{ id, label, host, user?, port?, identityFile?, proxyJump?, extraArgs?, note?, createdAt, updatedAt, lastProbe?, auth, agentAccess, allowedCommands, remoteTimeoutMs?, maxOutputBytes? }`, validated by zod on every read and write, so a hand-edited file cannot smuggle a bad record into the page (it surfaces as `storage-error` instead).
- table `sessions`: `{ sessionId, targetId, setAt }` — the target one conversation
  picked, so a remote call can omit `target`. `remove` clears the rows that point
  at a deleted target.
- global slot: `{ command, probeTimeoutMs, maxOutputBytes, remoteTimeoutMs, maxTransferBytes }`.

Format history: 1 = targets only, 2 = added `auth`, 3 = added the agent fields and
the `sessions` table. Every added field is optional with a default that reproduces
what the earlier version meant, so an existing file keeps opening — and the
`json` backend stamps the unit with the version it last wrote.

The file's shape, asserted by an integration run against the published json
backend:

```json
{ "unit": { "name": "ssh_targets", "version": 3 },
  "global": { "command": "ssh", "probeTimeoutMs": 10000, "maxOutputBytes": 65536, "remoteTimeoutMs": 30000, "maxTransferBytes": 33554432 },
  "tables": { "connections": { "ssh-0123456789": { "id": "…", "label": "…", "host": "…", "auth": "password", "agentAccess": "on", "allowedCommands": ["git"], "extraArgs": ["-4"], "createdAt": "…", "updatedAt": "…", "lastProbe": { "status": "auth-failed" } } }, "sessions": { "session-77": { "sessionId": "session-77", "targetId": "ssh-0123456789", "setAt": "…" } } }
```

Bounds live in `src/storage.ts`: 64 targets, 4 concurrent remote operations
shared by probes and commands, 12 per `probeAll` round, 1 s–120 s probe timeout,
1 s–300 s command timeout, 1 KiB–4 MiB output ceiling, 1 KiB–512 MiB transfer
ceiling, and at most 32 allowlisted program names of 64 characters each.

Record format is `version: 3` with `compatibleVersions: [1, 2]`.

The shared settings slot now carries five fields; the two ceilings the agent
uses (`remoteTimeoutMs`, `maxTransferBytes`) are editable on the Client settings
tab beside the probe ones.

### Credentials

Passwords and key passphrases do not live in the storage domain. `secrets.ts`
keeps them as `grant` records in the credential store — `credentialKey('ssh',
'<target-id>-password')` and `…-passphrase`, so `$DSH_HOME/.credentials.yaml`
under `records:` — written with `modifyRecord`, removed with `deleteRecord`
(deleting a target forgets both slots), and read back only when a probe needs a
value. The seam's rules that matter here: each key segment must match
`^[a-z][a-z0-9-]*$` (which is why target ids are `ssh-<10 hex>`), a mutate
callback returns a promise, an empty value is absent rather than blank, and the
store file must carry no permission bits outside its owner.

`askpass.ts` materializes the helper that lets `ssh` ask for one of those secrets
with no terminal: `mkdtemp($TMPDIR/dsh-ssh-askpass-)` at mode `0700`, one
`askpass.sh` at mode `0700`, removed by the plugin's disposer. It reads the
prompt text `ssh` passes as `$1` and answers from `DSH_SSH_ASKPASS_PASSPHRASE` or
`DSH_SSH_ASKPASS_PASSWORD`, falling back to whichever slot is filled.

### Tool (`src/tool.ts`)

One tool, `remote`, registered through `ctx.tools.register(defineTool(…))` inside
`ctx.effect` — a third-party bundle needs no preset entry: the registry feeds its
schemas into the system-prompt assembly on its own (the installed `dsh-github-flow`
bundle is the live proof of that).

| Field | Shape |
| --- | --- |
| `action` | `targets` \| `run` \| `ls` \| `read` \| `write` \| `upload` \| `download` |
| `localPath`, `recursive` | the local side of a transfer; relative paths resolve inside the conversation workspace |
| `target` | id, display name (any case), `host`, or `user@host`; omitted means this conversation's chosen target, then a lone saved target |
| `command` / `path` / `content` | the remote command line, an absolute remote path, and the exact text to write |
| `overwrite` / `append` / `mkdir` | write behaviour; `mkdir` defaults to true |
| `timeoutMs` / `maxBytes` | per-call overrides of the shared ceilings |
| `output` | `oneOf` per action, each `additionalProperties: false`; `execute` returns the canonical value and `output.render` writes the transcript text. The registry validates that value against the projected schema, so a branch that omits a field the producer emits rejects the whole call — the suites therefore validate every action's payload with `validateJsonSchemaValue`, not just its contents |

Policy is decided in `tools/pre-execute`, not inside the tool, which is what the
tool-authoring docs prescribe for deployment policy:

| Call | Verdict |
| --- | --- |
| `targets`, `ls`, `read` | allow |
| `run`, program in the target's `allowedCommands` | allow |
| `run`, program not allowlisted | **ask** |
| `run`, a pipeline / redirection / substitution (no single leading program) | **ask** |
| `write`, `upload` | **ask** |
| `download` | allow (it reads the server and writes inside the session workspace, which the file pipeline already governs) |
| any action on a target with `agentAccess: off` | deny, naming the settings page |
| storage unreadable at gate time | deny — running blind on a remote host is worse |

An `ask` is resolved by the harness approval UI (`ctx.approval`, answered through
the standard tool-approval surface) with `displayReason` supplied in English and
Chinese, and a missing approval service turns an `ask` into a denial rather than a
pass. The tool body re-checks only the hard stop (`agentAccess`), because it
cannot know whether the gate already obtained consent.

The name `remote` is a shared extension point: the registry is probed with
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
was written and re-checked through 0.5.1, and reproduced against a live server for
the 0.5.1 fix, so the next round does not have to re-derive them:

- File transfer: `scp` is the sibling of the configured `ssh` executable
  (`/usr/bin/ssh` → `/usr/bin/scp`); it takes the port as `-P` (not `-p`), accepts
  the same `-o BatchMode` / `StrictHostKeyChecking=accept-new` / `-i` / `-J` /
  `PreferredAuthentications` flags, and reads the remote end as one `host:path`
  argument, so no local shell is involved and a path with spaces needs no quoting.
  Both directions name the far end `host:path` — a download that passed the bare
  remote path copied locally instead, which is what the first live check caught.
  A size and type pre-check (`stat -c '%s %F' -- '<path>'`, GNU coreutils here) runs
  before a download so an oversized or directory payload is refused without
  touching the disk. `rsync` is absent on this machine and is therefore not used.
- The composer's session-options seat (`conversation.input.model.options`) declares
  no owner props and receives `sessionId` among its standard props; a live check in
  this profile showed the plugin's `ssh-target` occupant registered and active
  beside the shipped `agent-team` one.
- Tool authoring, as documented in `docs/cookbook/adding-a-tool.md` and
  `packages/core/tools`: `output` with `{ schema, render }` is mandatory;
  `execute` returns only the canonical JSON value that the registry validates,
  freezes, and hands to `render`; a thrown or invalid value becomes `isError`.
  `ToolRegistrationOptions` has exactly one field (`when`), scope comes from the
  calling context (registering at profile root makes the tool global), and the
  registration is effect-owned, so disposing the fiber unregisters it.
  `presentCall` / `presentResult` are consumed by native presenters only — the Web
  client renders from `tool/call` and `tool/result` events, and a plugin that wants
  a custom chat card registers its wire name in `tool.call.toolview`. The reserved
  name `run_code` cannot be taken.
- `ctx.storageDomain.open(spec)` → `Domain` with `table(name)` (`get`, `keys()`,
  `entries()` as `[key, value]`, `size`, `put`, `delete`, `deleteMany`,
  `update(key, fn)` atomic read-modify-write), `global.get()` /
  `global.set(value)`, and `close()`; writes serialize on one chain and emit
  `domain/changed` after landing. `defineDomain` rejects a name outside
  `/^[a-z][a-z0-9_]*$/` at module load, and an invalid stored record rejects the
  whole `open` with `invalid-record` (authoritative-data policy, kept deliberately).
- The json backend stores one document per unit, hence one
  `storages/ssh_targets.json` beside the profile's existing `storages/workspace.json`.
  A unit has exactly one live handle: `kv.open` throws if the same unit is opened
  twice, and the storage-domain facility enforces one open per domain name, which
  is why this plugin opens once in `apply` and closes in its disposer.
- `ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`
  is the third-party bundle's channel: no Typert generator runs for an external
  package, so there is no generated `ctx.remote` namespace to call.
- `settings.section` registration is `{ id, order?, label?, locale?, inject? }`
  and its owner props are only `{ close }`; shipped sections sit at
  `signin` -1, `general` 0, `models` 10, `plugins` 15, `agent-presets` 20, so 25
  and 26 land last, one per page. `settings.section.icon` addresses a section by
  its exact id and is rendered with `{ size: 16, active }`; an unmatched id never
  renders and an unregistered one falls back to the shell glyph. Both pages and
  both icons were observed live in the `web` profile at 0.3.0 (`active: true`).
- `ctx.locale.register(ns, language, dict)` requires both `en` and `zh`; a
  registration after mount is picked up without a remount, and a `label` thunk is
  re-read on every projection, so the nav text follows the language without
  re-registering.
- The browser module table seeds `react`, `react/jsx-runtime`, `react-dom`,
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`,
  `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`,
  `dsh-client-ui-dockkit`. Only `react` is required here, and the live theme
  exposes the `--dsw-alias-*` tokens this page styles with.
- The host tab primitive lives in
  `packages/client/ui-primitives/src/SegmentedControl.tsx` and its stylesheet:
  tab ids `<id>-<value>`, the panel `<id>-<value>-panel` labelled back with
  `aria-labelledby`, a roving `tabIndex`, an Arrow / Up / Down / Home / End walk
  that steps enabled neighbours and wraps, focus that follows the selection, and
  a sliding indicator placed arithmetically from two custom properties rather
  than by measuring the DOM. Every token that strip uses is defined in
  `packages/client/ui-theme/src/styles/` (`--dsw-alias-interactive-bg-hover`,
  `--dsw-radius-md`, `--dsw-radius-sm`, `--dsw-elevation-soft`,
  `--dsw-focus-ring-width`, `--dsw-focus-ring-color`), so copying the rules gives
  a plugin the same look without loading the primitive as a module.
- Child processes start from the parent environment minus names matching
  `/KEY|PASSWORD|SECRET|TOKEN/i` and minus every `DSH_*` name, so
  `SSH_AUTH_SOCK` reaches `ssh` (an agent keeps working) while a
  passphrase-shaped variable would not — a secret therefore has to be handed to
  `spawn` explicitly, which is what the askpass plumbing does.
- OpenSSH on this machine is `OpenSSH_10.0p2`, and `SSH_ASKPASS_REQUIRE=force`
  (8.4+) is what makes an askpass answer possible with no tty and no `DISPLAY`.
  Verified end to end by running the generated helper with `/bin/sh`: a
  `Enter passphrase for key …` prompt returns the passphrase, a `password:`
  prompt returns the password, and an empty environment answers an empty line
  instead of hanging.
- Mode-to-command mapping, asserted against a fake subprocess provider: `key`
  keeps `BatchMode=yes -o PreferredAuthentications=publickey`; `key` with a
  passphrase and `key+password` set `BatchMode=no`, `NumberOfPasswordPrompts=1`,
  and export the helper; `password` adds `PubkeyAuthentication=no` with
  `PreferredAuthentications=password,keyboard-interactive` and no key
  restriction. A mode that needs a secret while the helper is unavailable is
  refused as `secret-error` rather than left to burn the deadline.
- Since 0.5.0 the page offers two modes: `connectionInputSchema` and
  `probeDraftSchema` accept `key | password`, while `connectionRecordSchema` still
  accepts the 0.4.0-only `key+password` and `SshRunner` still implements its
  branch, so a legacy or hand-edited record reads and probes without turning the
  list into a `storage-error`. The record format stays at version 2.
- The probe command line, asserted by the offline smoke run:
  `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=3
  -o ServerAliveInterval=1 -o PreferredAuthentications=publickey -p 22022
  -i /home/j/.ssh/id -J jump -o PreferredAuthentications=publickey jiegg@build-box true`.

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
- `list` reports `runsAs` (`uid`, `user`, `home`) from the Host process, because
  a probe reads that account's `~/.ssh`, not the terminal user's. On this
  deployment the Host runs as uid 1024 with no `passwd` entry while the shell
  account is uid 1000 — exactly the confusion the identity card answers.

## Planned surface for the next round

1. An agent tool over the same `ops` methods (`hosts` / `probe` / `run`), which
   is why every operation already returns an explicit status rather than a
   rendered string, and why the probe classification is a pure function.
2. File transfer over the same transport (`upload`, `download`, directories
   through `scp -r`), which is the remaining action pair of this tool.
3. A `tool.call.toolview` card registered under the tool's wire name, so a remote
   command reads like the built-in terminal card instead of a generic row.
4. Optional: read `~/.ssh/config` aliases as a suggested inventory (`ctx.fs`).

## Limits of 0.6.0

- One settings page, its two tabs, is the only surface; the agent cannot see the
  list yet.
- A probe reads the **Host account's** ssh world — its `~/.ssh/config`, keys,
  agent, and `known_hosts` — not the terminal user's, so a working alias in a
  shell can still resolve differently here. The Client settings tab names the
  account, and the first probe records an unknown host key rather than asking.
- Nothing about these fixes is live until the running Host loads the new module:
  an in-place package swap keeps the previous one until the process restarts.
- A page probe still authenticates and runs only `true`; real commands come from
  the agent's `run` action.
- Remote calls are synchronous: no PTY, no terminal input, no background job. A
  command that waits for a prompt hits its deadline.
- A download is not announced through the `fs/write-intent` waterfall, so outside a
  git workspace it will not appear in the session's file-change summary even though
  the file itself lands (in a git workspace the turn-boundary snapshot covers it).
  Firing that waterfall is the natural follow-up, and so is a `tool.call.toolview`
  card for the tool, which the Web client renders from the wire tool name.
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
