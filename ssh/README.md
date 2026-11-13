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
    ├── tool.ts               # the agent-facing `ssh_client` tool and its policy gate
    ├── transfer.ts           # scp moves, with a remote size and type pre-check
    ├── local-path.ts         # the workspace boundary a local transfer path obeys
    ├── edit.ts               # the pure match-and-replace rules behind `edit`
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
# Lint with the harness checkout's oxlint when it is near; it is the cheapest
# check for the dead code a type pass leaves behind:
#   /data/deepseek-harness/node_modules/.bin/oxlint src scripts
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
| `exec` | `{ command, target?, sessionId?, timeoutMs?, maxOutputBytes? }` | `{ run, connection?, connections }` |
| `resolve` | `{ target?, sessionId? }` | `{ action: 'resolve', ok, target, resolved, stored, differs, text? }` |
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

One tool, `ssh_client`, registered through `ctx.tools.register(defineTool(…))` inside
`ctx.effect` — a third-party bundle needs no preset entry: the registry feeds its
schemas into the system-prompt assembly on its own (the installed `dsh-github-flow`
bundle is the live proof of that).

| Field | Shape |
| --- | --- |
| `action` | `get_connection` \| `exec` \| `read` \| `write` \| `edit` \| `upload` \| `download` — `read` answers a directory listing, a file's text, or a refusal, depending on what the path is |
| `localPath`, `recursive` | the local side of a transfer; relative paths resolve inside the conversation workspace |
| `target` | id, display name (any case), `host`, or `user@host`; omitted means this conversation's chosen target, then a lone saved target |
| `command` / `path` / `content` | the remote command line, an absolute remote path, and the exact text to write |
| `oldText` / `newText` | for `edit`: the exact text to find (copied from a read) and its replacement; an empty `newText` deletes |
| `all` / `replaceFirst` / `backup` | for `edit`: replace every occurrence / only the first / skip the `<path>.dsh-bak` copy |
| `overwrite` / `append` / `mkdir` | write behaviour; `mkdir` defaults to true |
| `timeoutMs` / `maxBytes` | per-call overrides of the shared ceilings |
| `output` | `oneOf` per action, each `additionalProperties: false`; `execute` returns the canonical value and `output.render` writes the transcript text. The registry validates that value against the projected schema, so a branch that omits a field the producer emits rejects the whole call — the suites therefore validate every action's payload with `validateJsonSchemaValue`, not just its contents |

Policy is decided in `tools/pre-execute`, not inside the tool, which is what the
tool-authoring docs prescribe for deployment policy:

| Call | Verdict |
| --- | --- |
| `get_connection`, `read` (a listing or a file's text), `download` | allow |
| `exec`, program in the target's `allowedCommands`, or no allowlist at all | allow |
| `exec`, program not on a non-empty allowlist | **ask** |
| `exec`, a pipeline / redirection / substitution (no single leading program) | **ask** |
| any `ask`, in a conversation whose approval policy is `never` | **allow** — the core rejects unanswered asks by policy, so asking there is a self-inflicted refusal |
| `write`, `edit`, `upload` | **ask** |
| `download` | allow (it reads the server and writes inside the session workspace, which the file pipeline already governs) |
| any action on a target with `agentAccess: off` | deny, naming the settings page |
| storage unreadable at gate time | deny — running blind on a remote host is worse |

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
was written and re-checked through 0.5.1, and reproduced against a live server for
the 0.5.1 fix, so the next round does not have to re-derive them:

- `ssh -G <target>` is a **local** operation: it prints the resolved
  configuration and exits without dialing, so the Resolve button cannot hang,
  cannot leak a credential, and answers the alias question instantly. The plugin
  passes only its own port/key/jump/extra-flag overrides, so what it prints is
  what a probe would dial.
- `fs/write-intent` is a single-slot **decision** waterfall: a listener may
  answer `createIfAbsent` or `replaceIfVersion` and never consults your write, so
  the plugin must act on the answer — a create-only guard against an existing file
  is a refusal, and a version guard cannot be honoured by an external copy and is
  reported as such. The session change recorder attaches the edit by **object
  identity** of the actor it saw at `tools/pre-execute`, which is why the plugin
  hands the live tool execution to the waterfall and not a look-alike.
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
- `list` reports `runsAs` (`uid`, `user`, `home`) from the Host process, because
  a probe reads that account's `~/.ssh`, not the terminal user's. On this
  deployment the Host runs as uid 1024 with no `passwd` entry while the shell
  account is uid 1000 — exactly the confusion the identity card answers.

## Planned surface for the next round

1. An agent tool over the same `ops` methods (`list` / `probe` / `runCommand`), which
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
  the agent's `exec` action.
- Remote calls are synchronous: no PTY, no terminal input, no background job. A
  command that waits for a prompt hits its deadline.
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
