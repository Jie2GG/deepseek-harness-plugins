# @jie2gg/dsh-plugin-github

Manage the local GitHub CLI from DeepSeek Harness. Version **0.2.0** adds the
settings page; the user-facing wording lives in [docs/DETAIL.md](docs/DETAIL.md)
and [docs/DETAIL.zh.md](docs/DETAIL.zh.md).

The page has two cards: **Accounts** (`gh auth status` / login with the browser or
a token / switch / logout / copy token) and **Installation** (resolved path and
version, newest `cli/cli` release, managed tarball install, and the plugin's own
`command` configuration).

## Layout

```
github/
├── package.json              # bundle manifest: dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # one Host plugin row: id `github`, config {}
├── tsconfig.json             # NodeNext ESM, src/ → lib/, rewriteRelativeImportExtensions
├── icon.svg                  # original artwork (git branch marks + prompt caret)
├── scripts/finalize-client.mjs  # post-build step that proves lib/client.js is a script
├── docs/DETAIL.md            # plugin detail page, English
├── docs/DETAIL.zh.md         # plugin detail page, Chinese
├── locale/en.json            # meta.title / meta.description / meta.detail (docs/DETAIL.md)
├── locale/zh.json            # same, Chinese; its meta.detail names docs/DETAIL.zh.md
└── src/
    ├── index.ts              # entry: name, inject, Config, apply → route + jobs
    ├── config.ts             # Config interface + Schemastery validation + clamps
    ├── types.ts              # shared vocabulary, RPC method list, route constants
    ├── gh.ts                 # every `gh` call, through ctx.subprocess
    ├── installer.ts          # release metadata + managed tarball install
    ├── jobs.ts               # progress table for the flows the page watches
    ├── ops.ts                # the operations behind each RPC method
    ├── rpc.ts                # /api/github/rpc: decode, validate, dispatch, encode
    ├── client.ts             # browser half (a module-loader script, see below)
    └── client-globals.d.ts   # ambient window/navigator types for that script
```

## Build and install

`lib/` is git-ignored, so build before installing from the directory. The lockfile
is committed for a reproducible dev install; it plays no part at runtime, because
DSH resolves the peer `@deepseek-ai/*` packages from its own installation.

```sh
cd github
pnpm install     # devDependencies only: typescript, @types/node, @deepseek-ai/*
pnpm run check   # tsc --noEmit
pnpm run build   # tsc → lib/, then scripts/finalize-client.mjs
```

Then in a running Harness: `plugin_manager` → `install_bundle` with the absolute
path of this directory. Acceptance per the repository rules: no manifest
diagnostics, and the title, description, icon, and detail document render in both
English and Chinese.

## Host API

`src/index.ts` exports:

| Export | Shape | Notes |
| --- | --- | --- |
| `name` | `'github'` | Cordis plugin name for loader diagnostics. |
| `inject` | `['connection', 'subprocess', 'configEditor']` | Optional-service rule: a profile without them leaves the plugin inactive instead of throwing. |
| `Config` | Schemastery object | `command`, `timeoutMs`, `maxOutputBytes`; see [docs/DETAIL.md](docs/DETAIL.md) for defaults and bounds. |
| `apply(ctx, config)` | void | Registers one Fetch route and owns the job table for the activation. |

The page's only Host entry point is `POST /api/github/rpc` (GET is accepted for
`status`, `authStatus`, `releaseCheck`, and `jobPoll`). It is registered through
`ctx.connection.fetch.register`, so it lives on the shared `/api` channel and only
the owner peer of the served page reaches it; every other principal gets 403 from
the shared handler. One envelope for both directions:

```jsonc
// request
{ "method": "authLoginWeb", "params": { "host": "github.com", "gitProtocol": "https" } }
// success
{ "ok": true, "result": { "jobId": "…" } }
// refusal — the page renders message plus hint
{ "ok": false, "error": { "code": "network", "message": "…", "hint": "…" } }
```

| Method | Result | Effect |
| --- | --- | --- |
| `status` | `StatusView` | 5 s cached: resolved path, version, source, managed copy, cached release, platform, extensions, running jobs. |
| `authStatus` | `AuthStatusView` | `gh auth status --json hosts --no-refresh`, parsed — no text scraping. |
| `authToken` | `{ token, host }` | `gh auth token --no-refresh`; crosses only on an explicit page action. |
| `authLoginToken` | `{ message }` | `gh auth login --with-token` with the token fed through stdin. |
| `authLoginWeb` | `{ jobId }` | `gh auth login --web`; the job captures the one-time code, answers the Enter prompt, and waits for the browser. |
| `authLogout` / `authSwitch` | `{ message }` | `gh auth logout` / `gh auth switch`. |
| `releaseCheck` | `{ latest, current, upToDate, checkedAt }` | `GET api.github.com/repos/cli/cli/releases/latest`, Bearer token when `gh` has one. |
| `installStart` | `{ jobId }` | Download → sha256 verify against `gh_<v>_checksums.txt` → `tar -xzf` → atomic place → run `--version` → point `command` at it when PATH prefers another copy. |
| `removeManaged` | `{ removed, commandCleared }` | Deletes only the managed file, clearing `command` when it pointed there. |
| `configUpdate` | `{ applied, restarting: true }` | Writes this row's `command` through `configEditor`; the write restarts the plugin. |
| `jobPoll` / `jobCancel` | `{ job }` or `{ stale: true }` | Progress for sign-in and install. `stale` means the plugin restarted, so the page reloads status. |

`GhErrorCode` is a closed union: `gh-missing`, `gh-failed`, `timeout`, `network`,
`checksum`, `extract`, `permission`, `unsupported-platform`, `busy`, `bad-input`,
`config-rejected`, `internal`. `rpc.ts` maps them to HTTP statuses
(400/408/409/424/500/502) so a `curl` caller can tell retryable from wrong.

## Client API

`src/client.ts` is authored as a **script**: it contains only `import type`
statements, and `scripts/finalize-client.mjs` strips the `export {};` marker that
TypeScript appends to a type-only module, then fails the build if any top-level
`import`/`export` survives or if the artifact registers anything other than exactly
one `window.__ModuleLoader__.load({ id: '@jie2gg/dsh-plugin-github', … })` entry.
React comes from the browser module table through `require('react')`, elements are
built with `React.createElement` (no JSX toolchain), and no DSH Client package is
imported — controls are local and styled from `--dsw-alias-*` tokens only.

The page is registered into the `settings.section` slot owned by
`@deepseek-ai/dsh-client-ui-settings-general` (`order: 25`, after
`agent-presets`), and its copy is registered as the `settings.github` Client
locale namespace with `en` + `zh` dictionaries kept inside the artifact, because a
plugin's `locale/*.json` files carry panel metadata rather than browser
dictionaries. Navigation labels are thunks, so they follow the active locale
without a re-register.

## Design notes

- **One operation, two callers.** Every action is a method on `createOps`, so the
  future agent tool can wrap the same functions instead of duplicating logic.
- **No typert dependency.** A third-party bundle has no Typert generator run, so
  the page talks to the Host over the registered Fetch route rather than a
  generated `ctx.remote` namespace.
- **Prompts fail loudly.** Children start with `GH_PROMPT_DISABLED=1`,
  `GH_NO_UPDATE_NOTIFIER=1`, and `NO_COLOR=1`. `ctx.subprocess` scrubs
  credential-shaped names, so `GH_TOKEN` / `GITHUB_TOKEN` never reach `gh` unless
  the plugin forwards them; the keyring credential this machine already uses is
  unaffected.
- **Nothing system-level is touched.** The managed copy lives under
  `$XDG_DATA_HOME/dsh-plugin-github/bin` (default `~/.local/share/...`), and
  `install` never runs a package manager. Because a user-level install may sit
  behind another `gh` in `PATH`, the page reports `shadowed` and the plugin keeps
  pointing at whichever path it resolved.
- **Restarts are expected.** A `command` write goes through the profile patch
  layer and restarts this plugin, which discards its in-memory job table; the page
  reads `stale` from `jobPoll` and reloads status instead of assuming the worst.
- **Verified contracts** (against the running DSH `0.2.2-rc.1`): `defineTool`
  needs `output.schema` + `output.render` (`@deepseek-ai/dsh-tools`) for the next
  round; `ctx.subprocess.spawn` takes an explicit `argv`/`cwd`/`stdio`/`graceMs`
  spec and keeps collected streams readable after exit; `ctx.configEditor.edit`
  validates through `fiber.resolveConfig` and rejects values a higher layer
  overrides; `engines.dsh` alone decides compatibility.

## Limits of 0.2.0

- No agent tool yet, and no Web UI beyond the settings page.
- Automatic install is Linux-tarball only; macOS and Windows get an explanatory hint.
- `gh auth refresh` and other TTY-bound flows are not offered.
- Only `en` and `zh` dictionaries: other UI languages fall back to English.

## License

Apache-2.0 — see [LICENSE](../LICENSE) at the repository root. The icon is
original artwork by this repository's maintainer under the same license; it does
not use GitHub's Invertocat or Octocat marks.
