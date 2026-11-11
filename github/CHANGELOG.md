# Changelog

All notable changes to `@jie2gg/dsh-plugin-github` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## 0.2.0

### Added

- A **GitHub** page in the Harness settings panel (`settings.section`, order 25),
  in English and Chinese.
- **Accounts**: hosts and accounts from `gh auth status --json`, sign in through
  the browser device-code flow (the one-time code and URL appear as soon as `gh`
  prints them, with cancel), sign in with a pasted token, switch the active
  account, log out with an inline confirmation, and copy one account's token.
- **Installation**: the resolved `gh` path, version, and where the path came from;
  the newest `cli/cli` release with an up-to-date verdict; download-and-verify
  install of the official Linux tarball into a plugin-managed directory with a
  managed-copy delete; and editing the plugin's own `command` configuration.
- `Config` fields `command`, `timeoutMs`, and `maxOutputBytes`, with defaults and
  bounds applied at activation, plus `inject = ['connection', 'subprocess', 'configEditor']`.
- One Host entry point, `POST /api/github/rpc`, registered on the shared `/api`
  channel through `ctx.connection.fetch`, with a closed refusal-code vocabulary
  mapped onto HTTP statuses and a job table for the two long-running flows.
- `scripts/finalize-client.mjs`, which strips the module marker TypeScript adds to
  the type-only client source and fails the build if the emitted `lib/client.js`
  is not a classic script registering exactly one module-loader entry.

### Changed

- `src/index.ts` is no longer inert; `apply` wires the Host services and route.
- Package manifest now declares `dsh.client` and exports `./client`; `files`
  carries the whole `lib/` tree.
- `locale/*/docs` display text now describes the delivered page instead of the
  0.1.0 scaffold.

## 0.1.0

### Added

- Bundle scaffold for a plugin that will manage the local GitHub CLI:
  `package.json` with the repository's required fields, `cordis.patch.yml`
  inserting the `github` plugin row, `src/index.ts`, an original `icon.svg`,
  `locale/en.json` and `locale/zh.json` display metadata, and
  `docs/DETAIL.md` / `docs/DETAIL.zh.md` detail documents.
- TypeScript build (`pnpm run build` → `lib/`) so the manifest's `main` and
  `exports` point at real build artifacts while `lib/` stays git-ignored.

### Notes

- The plugin is inert: no agent tool, no configuration fields, no Web UI, and no
  `gh` invocation. Enabling or disabling it changes nothing in the app.
