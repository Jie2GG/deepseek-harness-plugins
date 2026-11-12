# @jie2gg/dsh-plugin-ssh

Manage the SSH targets this machine reaches from the Harness settings panel: a
named inventory, per-target connectivity probes, and the client settings those
probes honour. User-facing wording lives in [docs/DETAIL.md](docs/DETAIL.md)
(and [docs/DETAIL.zh.md](docs/DETAIL.zh.md) for Chinese).

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
    ├── ssh.ts                # SshRunner: executable lookup, spawn, result classes
    ├── ops.ts                # one method per RPC name, transport-agnostic
    ├── rpc.ts                # Request → Response, failure code → HTTP status
    ├── client.ts             # browser half: the settings section + its icon
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
| `inject` | `['connection', 'subprocess', 'storageDomain']` | Hard requirements: without them the row stays inactive rather than throwing. |
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
| `list` | – | `{ connections, settings, limits, probing }` |
| `save` | `{ connection }` (no `id` = create) | `{ connection, connections }` |
| `remove` | `{ id }` | `{ removed, connections }` |
| `probe` | `{ id }` or `{ draft }` | `{ connection?, probe?, connections }` |
| `probeAll` | – | `{ connections, probed, skipped, failures }` |
| `configUpdate` | `{ settings }` | `{ settings }` |

`GET` reaches only `list`; the route rides the shared `/api` channel, so only the
owner peer of the served page is admitted and every other principal is refused.

### Storage

One domain, `ssh_targets` (`version: 1`), on the backend the profile routes for
it — the `json` backend writes one document per unit, at
`$DSH_HOME/storages/ssh_targets.json`:

- table `connections`: `{ id, label, host, user?, port?, identityFile?, proxyJump?, extraArgs?, note?, createdAt, updatedAt, lastProbe? }`, validated by zod on every read and write, so a hand-edited file cannot smuggle a bad record into the page (it surfaces as `storage-error` instead).
- global slot: `{ command, probeTimeoutMs, maxOutputBytes }`.

The file's shape, asserted by an integration run against the published json
backend:

```json
{ "unit": { "name": "ssh_targets", "version": 1 },
  "global": { "command": "ssh", "probeTimeoutMs": 10000, "maxOutputBytes": 65536 },
  "tables": { "connections": { "ssh-0123456789": { "id": "…", "label": "…", "host": "…", "extraArgs": ["-4"], "createdAt": "…", "updatedAt": "…", "lastProbe": { "status": "auth-failed" } } } } }
```

Bounds live in `src/storage.ts`: 64 targets, 4 concurrent probes, 12 per
`probeAll` round, 1 s–120 s probe timeout, 1 KiB–4 MiB output ceiling.

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
was written and re-checked at 0.3.0, so the next round does not have to
re-derive them:

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
  passphrase-shaped variable would not.
- The probe command line, asserted by the offline smoke run:
  `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -p 22022
  -i /home/j/.ssh/id -J jump -o PreferredAuthentications=publickey jiegg@build-box true`.

## Planned surface for the next round

1. An agent tool over the same `ops` methods (`hosts` / `probe` / `run`), which
   is why every operation already returns an explicit status rather than a
   rendered string, and why the probe classification is a pure function.
2. Remote command execution under host and command allowlists, reusing
   `SshRunner` with a different argv tail.
3. A passphrase through `ctx.credentials.modifyRecord()`, which keeps it out of
   both the storage domain and the patch file; `BatchMode=yes` stays until then.
4. Optional: read `~/.ssh/config` aliases as a suggested inventory (`ctx.fs`).

## Limits of 0.3.0

- One settings page, its two tabs, is the only surface; the agent cannot see the list yet.
- A probe can only use what a non-interactive `ssh` already has: an agent or a
  key without a passphrase.
- Deleting the bundle leaves `storages/ssh_targets.json` behind.
- `private: true`: not published to npm while the status is `experimental`.

## License

Apache-2.0 — see [LICENSE](../LICENSE) at the repository root. The icon is
original artwork by this repository's maintainer under the same license: a
terminal caret linked by a dashed line to a server rack, not a third-party mark.
