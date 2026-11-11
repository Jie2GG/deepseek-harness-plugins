# @jie2gg/dsh-plugin-github

Manage the local GitHub CLI (`gh`) from DeepSeek Harness. Version **0.1.0 is a
scaffold only**: the plugin activates and does nothing. See
[docs/DETAIL.md](docs/DETAIL.md) for the user-facing wording (and
[docs/DETAIL.zh.md](docs/DETAIL.zh.md) for Chinese).

## Layout

```
github/
├── package.json          # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      # inserts one Host plugin row: id `github`
├── tsconfig.json         # NodeNext ESM, src/ → lib/
├── icon.svg              # original artwork (git branch marks + prompt caret)
├── docs/DETAIL.md        # plugin detail page, English
├── docs/DETAIL.zh.md     # plugin detail page, Chinese
├── locale/en.json        # meta.title / meta.description / meta.detail
├── locale/zh.json        # same, Chinese; its meta.detail names DETAIL.zh.md
└── src/index.ts          # plugin entry: name + inert apply()
```

## Build and install

`lib/` is git-ignored, so build before installing from the directory. The
lockfile is committed for a reproducible dev install; it plays no part at runtime,
because DSH resolves the peer `@deepseek-ai/*` packages from its own installation.

```sh
cd github
pnpm install     # devDependencies only: typescript, @types/node, @deepseek-ai/cordis
pnpm run check   # tsc --noEmit
pnpm run build   # emits lib/index.js + lib/index.d.ts
```

Then in a running Harness: `plugin_manager` → `install_bundle` with the absolute
path of this directory. Acceptance per the repository rules: no manifest
diagnostics, and the title, description, icon, and detail document render in both
English and Chinese.

## API

`src/index.ts` exports exactly:

| Export | Shape | Notes |
| --- | --- | --- |
| `name` | `'github'` | Cordis plugin name for loader diagnostics. |
| `apply(ctx)` | `(ctx: Context) => void` | Registers nothing; `ctx` is unused. |

No `inject` and no `Config` are declared, so the row's `config: {}` is accepted
as-is and the plugin activates in any profile.

## Design notes for the next round

Facts verified against the running DSH (`0.2.2-rc.1`), to save the implementer a
search:

- **Tool registration**: `ctx.tools.register(defineTool({ name, description,
  parameters, output: { schema, render }, execute }))` from
  `@deepseek-ai/dsh-tools`. `output` is mandatory — `render` returns the
  model-facing `ContentBlock[]` for the validated canonical JSON value.
- **Process execution**: `ctx.subprocess.resolveExecutable('gh')` then
  `ctx.subprocess.spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes },
  stderr: { maxBytes } }, graceMs })`; await `handle.done` and read
  `handle.collected.stdout?.readFrom(0)`. `argv` is never shell-interpreted.
  The service scrubs credential-shaped environment names, so `GH_TOKEN` /
  `GITHUB_TOKEN` do **not** reach `gh` unless the plugin forwards them
  explicitly — the local `gh` keyring keeps working without them.
- **Session directory**: `ctx.workingDirectory.ensure(exec.agent)` gives the
  calling session's workspace, which is what `gh pr list` and friends resolve the
  repository from. Add `workingDirectory` to `inject` so the plugin stays inert in
  profiles without it rather than throwing.
- **Config**: declare `export interface Config` plus a schemastery validator
  (`export const Config: z<Config> = z.object({ … })` from
  `@deepseek-ai/schemastery`). Only declared fields survive; the user edits them
  in the profile patch layer.
- **Version gating**: `engines.dsh` alone decides compatibility (peer
  `@deepseek-ai/dsh-*` ranges are ignored once `engines.dsh` is present), so keep
  both in sync when new DSH peers are added.

Planned surface (subject to change): one agent tool with `action` in
`status` / `auth` / `extensions` / `settings` / `run`, and `Config` fields
`command`, `allowedSubcommands`, `timeoutMs`, `maxOutputBytes`,
`useSessionWorkingDirectory`. Adding it means new peer dependencies
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-subprocess`) and matching
devDependencies for the build.

## Limits of 0.1.0

- No behaviour: nothing to observe beyond the plugin list entry.
- `gh` upgrade or installation is out of scope; this Linux host has no
  `gh upgrade` subcommand anyway (`gh 2.103.3` here), so any version check must go
  through the Releases API rather than the CLI.
- `private: true`: not published to npm while the status is `experimental`.

## License

Apache-2.0 — see [LICENSE](../LICENSE) at the repository root. The icon is
original artwork by this repository's maintainer under the same license; it does
not use GitHub's Invertocat or Octocat marks.
