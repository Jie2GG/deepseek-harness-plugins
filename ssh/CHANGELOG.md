# Changelog

All notable changes to `@jie2gg/dsh-plugin-ssh` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## 0.4.0

### Added

- **Three authentication modes per target: key, key + password, and password.**
  The choice is a segmented control under the address, and the ssh command line
  follows from it: key keeps `BatchMode=yes` with
  `PreferredAuthentications=publickey` (ssh-agent or an unencrypted key); key +
  password leaves method negotiation to OpenSSH so the key is tried first and the
  password answers as a fallback; password sets `PubkeyAuthentication=no` with
  `PreferredAuthentications=password,keyboard-interactive`. Every mode that can be
  prompted adds `NumberOfPasswordPrompts=1`, so a wrong secret fails fast instead
  of spending the probe deadline on retries.
- **A password or key passphrase can now be used without a terminal.** The plugin
  prepares a private `askpass` helper — a directory and script at mode `0700`
  under the system temp directory, removed when the plugin unloads — and exports
  `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force` plus the secret in a dedicated
  environment entry. `ssh` passes the prompt text to the helper, which answers a
  passphrase prompt with the passphrase and any other with the password, falling
  back to whichever slot is filled. The secret never appears in `argv`, and
  because the subprocess service scrubs credential-shaped and `DSH_*` names from
  every child, the value is handed over explicitly.
- **Secrets live in the Harness credential store, not in this plugin's file.** A
  target's password and passphrase are `grant` records addressed
  `ssh/<target-id>-password` and `ssh/<target-id>-passphrase`, written with
  `modifyRecord` and removed with `deleteRecord`; deleting a target forgets both.
  The store keeps them in `$DSH_HOME/.credentials.yaml`, readable by the owner
  only. The browser never receives a value: the list shows presence, a typed
  secret travels to the Host once, and leaving a field empty keeps what is stored.
- **The new-connection form is one address field, the authentication choice, the
  secret fields that choice needs, an optional display name, and a collapsed
  advanced section.** `[user@]host[:port]`, a bare alias, an IPv6 literal in
  brackets, and an `ssh://` prefix all parse into the stored `host`, `user`, and
  `port`, which the Host still keeps as separate fields. Secret inputs carry a
  reveal button, a “stored — leave empty to keep it” placeholder, and a checkbox
  that forgets the stored value. The list shows each target's mode and which
  secret slots are filled.
- A page-level warning when the Host cannot prepare the askpass helper, and a
  per-target `secret-error` refusal instead of a probe that would only hang.

### Changed

- Record format `version: 2` with `compatibleVersions: [1]`: a stored target
  without `auth` reads as `key`, which is exactly what 0.2.0 and 0.3.0 meant, so
  no existing record is rewritten or refused.
- `list` also returns the accepted ranges for the two numeric settings and the
  helper state, and `save` / `probe` accept a `secrets` object, so the settings
  tab no longer mirrors the ranges in browser code.
- The settings shell hands a plugin one navigation row per section, and the
  authentication choice is not a page: it is a `radiogroup` reusing the same
  vendored segmented strip, with `aria-checked` in place of `aria-selected`.
- A Host half that supports secrets reports itself through `list.askpass`; a page
  talking to a Host module that has not been restarted yet hides the
  authentication controls and says why, instead of failing on an unknown field.

### Notes

- The credential store keeps secrets out of the profile patch file and out of
  this plugin's JSON, but not away from the agent: agent tool processes run as the
  same OS user that can read `$DSH_HOME/.credentials.yaml`.
- A probe can still only run `ssh … true`; no remote command executes with the
  new secrets yet.

## 0.3.0

### Changed

- **One navigation entry, two tabs.** The 0.2.0 page keeps its single
  `settings.section` (id `ssh`, order 25, 远程连接 / Remote connections) and its
  icon; its content is now switched by a tab strip across the top: **SSH
  targets** (list, form, probes) and **Client settings** (the `ssh` executable,
  the probe timeout, the output ceiling). The settings shell has no grouping
  mechanism for plugin sections, so tabs are how two views live under one entry.
- The tab strip is the host's `SegmentedControl` **copied, not imported**: equal
  segments with a sliding indicator, `role="tablist"` / `role="tab"` /
  `aria-selected` / `aria-controls`, a `role="tabpanel"` the page labels back
  with `aria-labelledby`, a roving `tabIndex`, the same Arrow / Home / End walk,
  and focus-follows-selection. Classes are renamed under `dshssh-` and the
  styling references host tokens only (`--dsw-radius-md`, `--dsw-radius-sm`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-elevation-soft`,
  `--dsw-focus-ring-width`), because a plugin must not load another Harness
  client package as a module.
- The settings tab gained a read-only **Fixed bounds** card: target capacity,
  probe concurrency, the `probeAll` round size, and the accepted ranges for the
  two numeric fields, so a value the Host would reject is visible before it is
  typed.
- The extra-arguments hint states that one line is one `ssh` argv entry, because
  a spaced `-o value` pair must arrive as two lines.

### Notes

- No operation, route method, or stored field changed: both tabs use the same
  `list` / `save` / `remove` / `probe` / `probeAll` / `configUpdate` set over one
  page state, and the Host re-reads the settings at each probe, so a change on
  one tab takes effect on the other immediately. A probe started on the list tab
  keeps running while the settings tab is open.
- The selected tab is page-local: the page opens on **SSH targets**, and the
  choice is not persisted.

## 0.2.0

### Added

- A **Remote connections** page in the settings panel (`settings.section` id
  `ssh`, order 25) with its own navigation icon (`settings.section.icon`),
  registered by the new browser half in `src/client.ts`.
- SSH target storage: a named list of hosts and OpenSSH aliases with user, port,
  identity file, jump host, extra flags and a note, up to 64 entries, edited
  through the page (new / edit / delete with an inline confirm).
- Connectivity probes: `ssh -o BatchMode=yes -o ConnectTimeout=<n> … <host> true`
  run through `ctx.subprocess`, classified into reachable / authentication
  failed / unreachable / host key not trusted / timed out / ssh not found, with
  at most 4 concurrent probes and a `Test all` round covering the first 12.
- Client settings the page edits: the `ssh` executable, the probe timeout, and
  the captured output ceiling.
- The plugin's own durable storage domain `ssh_targets` (a `connections` table
  plus a global settings slot), read and written only by the Host; the browser
  reaches it over one route, `/api/ssh/rpc`, carried by the shared authenticated
  `/api` channel (`ctx.connection.fetch`).
- Browser copy for both baseline locales (`en`, `zh`) registered under the
  `settings.ssh` namespace.

### Changed

- **Data no longer lives in the profile patch file.** The 0.2.0 design dropped
  the planned `Config` fields: nothing is written to `cordis.patch.yml` and a
  save no longer restarts the plugin, because the storage domain owns every
  value. The row keeps `config: {}`.
- `package.json` gained the `./client` export, the `dsh.client` block, and a
  `build` step that finalizes `lib/client.js` into the classic-script form the
  web module table requires; `files` now ships the whole `lib/` tree.
- Runtime dependencies: `zod` and `@deepseek-ai/dsh-storage-domain` (the domain
  helpers); `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-config-editor` are
  no longer used.
- `inject` is now `connection`, `subprocess`, `storageDomain`: in a profile
  without any of them the plugin stays inactive instead of throwing.
- Display metadata and both detail documents describe the page and where the
  data is kept.

### Notes

- No agent tool yet: the Host methods are already shaped for one, so the next
  round can expose the same operations without touching storage or the route.
- No secret is stored: probes only use what a non-interactive `ssh` can use on
  its own (`SSH_AUTH_SOCK` reaches the child; passphrase-shaped variables do
  not). `known_hosts` is never written.

## 0.1.0

### Added

- Bundle scaffold for a plugin that will manage SSH hosts and run commands on
  them: `package.json` with the repository's required fields, `cordis.patch.yml`
  inserting the `ssh` plugin row, `src/index.ts`, an original `icon.svg`,
  `locale/en.json` and `locale/zh.json` display metadata, and
  `docs/DETAIL.md` / `docs/DETAIL.zh.md` detail documents.
- TypeScript build (`pnpm run build` → `lib/`) so the manifest's `main` and
  `exports` point at real build artifacts while `lib/` stays git-ignored.

### Notes

- The plugin is inert: no agent tool, no configuration fields, no Web UI, and no
  `ssh` invocation. Enabling or disabling it changes nothing in the app.
