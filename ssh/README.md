# @jie2gg/dsh-plugin-ssh

Manage SSH from DeepSeek Harness: an inventory of the hosts the local OpenSSH
client can reach, connectivity probes against them, and bounded remote command
execution. Version **0.1.0 is a scaffold only**: the plugin activates and does
nothing. See [docs/DETAIL.md](docs/DETAIL.md) for the user-facing wording (and
[docs/DETAIL.zh.md](docs/DETAIL.zh.md) for Chinese).

## Layout

```
ssh/
├── package.json          # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      # inserts one Host plugin row: id `ssh`
├── tsconfig.json         # NodeNext ESM, src/ → lib/
├── icon.svg              # original artwork (prompt caret + dashed link + server rack)
├── docs/DETAIL.md        # plugin detail page, English
├── docs/DETAIL.zh.md     # plugin detail page, Chinese
├── locale/en.json        # meta.title / meta.description / meta.detail
├── locale/zh.json        # same, Chinese; its meta.detail names DETAIL.zh.md
└── src/index.ts          # plugin entry: name + inert apply()
```

## Build and install

`lib/` is git-ignored, so build before installing from the directory. DSH
resolves the peer `@deepseek-ai/*` packages from its own installation, so the
lockfile (once committed) plays no part at runtime.

```sh
cd ssh
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
| `name` | `'ssh'` | Cordis plugin name for loader diagnostics. |
| `apply(ctx)` | `(ctx: Context) => void` | Registers nothing; `ctx` is unused. |

No `inject` and no `Config` are declared, so the row's `config: {}` is accepted
as-is and the plugin activates in any profile.

## Design notes for the next round

Facts verified against the running DSH (`0.2.2-rc.1`, `web` profile) while this
scaffold was written, to save the implementer a search:

- **The row id `ssh` is free here.** `Config.listConfigs` returns 219 live
  entries and none of them has id or `patchId` `ssh`; core rows are namespaced
  `include:<patchId>` and profile-installed bundles get hash ids. A deployment
  that composes the core SSH providers (next bullet) may use the same bare id, so
  prefer renaming this row over silently overriding a foreign one.
- **Harness already has an SSH *deployment*, and it is not this plugin's job.**
  The Host service catalog exposes `ssh` — “One non-reconnecting SSH session;
  loss invalidates all active operations.” — provided by `@deepseek-ai/dsh-ssh`
  and composed with `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` to make the
  Harness's own filesystem and processes remote (`packages/ssh/` in the DSH
  checkout). This plugin talks from the local machine to *other* hosts through
  the local OpenSSH client; reuse `ctx.ssh` only when the deployment connection
  is really the target.
- **Tool registration**: `ctx.tools.register(defineTool({ name, description,
  parameters, output: { schema, render }, execute }))` from
  `@deepseek-ai/dsh-tools` (`packages/core/tools/src/schema.ts`). `output` is
  mandatory — `render` returns the model-facing `ContentBlock[]` for the
  validated canonical JSON value.
- **Process execution**: `ctx.subprocess.resolveExecutable('ssh')` then
  `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs })`; await `handle.done` and
  read `handle.collected.stdout?.readFrom(0)`. `argv` is never shell-interpreted,
  which matters for remote command strings: pass the remote command as one argv
  element and let the remote shell do its own quoting.
- **Environment scrub**: children start from the parent environment minus names
  matching `/KEY|PASSWORD|SECRET|TOKEN/i` and minus every `DSH_*` name
  (`packages/subprocess/subprocess/src/index.ts`, `scrubbedParentEnv`). In
  practice `SSH_AUTH_SOCK` reaches `ssh`, so a running agent keeps working
  unaided, while a passphrase-shaped variable does not and must be forwarded
  explicitly or read from credentials.
- **Secrets**: store passphrases with `ctx.credentials.modifyRecord()` (declare
  `credentials` in `inject`, or read it with `ctx.get('credentials')`), never in
  `config` and never by rewriting the profile's `cordis.patch.yml`.
- **Config**: declare `export interface Config` plus a schemastery validator
  (`export const Config: z<Config> = z.object({ … })` from
  `@deepseek-ai/schemastery`). Only declared fields survive; the user edits them
  in the profile patch layer.
- **Version gating**: `engines.dsh` alone decides compatibility (peer
  `@deepseek-ai/dsh-*` ranges are ignored once `engines.dsh` is present), so keep
  both in sync when new DSH peers are added.

Planned surface (subject to change): one agent tool `ssh` with `action` in
`hosts` / `resolve` / `probe` / `run`, and `Config` fields `command`,
`configFiles`, `probeTimeoutMs`, `runTimeoutMs`, `maxOutputBytes`,
`allowedHosts`, `allowedCommands`. Adding it means new peer dependencies
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-subprocess`,
`@deepseek-ai/schemastery`) and matching devDependencies for the build.

## Limits of 0.1.0

- No behaviour: nothing to observe beyond the plugin list entry.
- Not yet installed or verified in a running profile — the display metadata,
  icon, and detail documents have not been exercised through `install_bundle`.
- `private: true`: not published to npm while the status is `experimental`.

## License

Apache-2.0 — see [LICENSE](../LICENSE) at the repository root. The icon is
original artwork by this repository's maintainer under the same license: a
terminal caret linked by a dashed line to a server rack, not a third-party mark.
