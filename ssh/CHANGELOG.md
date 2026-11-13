# Changelog

All notable changes to `@jie2gg/dsh-plugin-ssh` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## 0.6.0

### Added

- **The agent can use the remote now.** One tool, `remote`, with the actions
  `targets`, `run`, `ls`, `read`, `write`, `upload`, `download`. Each action calls
  the same `ops` method the settings page calls, so the chat and the page cannot
  drift apart, and the model sees one dense transcript line per call
  (`Proxy$ uname -a` then stdout, `[stderr]` then the exit and duration, or
  `status=auth-failed · exit=255` with a plain-language explanation).
- **A conversation picks its server from the composer.** The session-options menu
  (next to the model and reasoning controls) lists the saved targets as radio rows
  plus **No remote server**; the choice is stored in the plugin's own storage
  (`sessions` table) and reused by every call that does not name a target. The
  resolution order is explicit argument → this conversation's choice → a lone
  saved target, and an ambiguous call refuses with the candidate list instead of
  guessing.
- **Policy that matches how the harness gates tools.** The decision lives in
  `tools/pre-execute`, not in the tool body: reads (`ls`, `read`, `targets`,
  `download`) run free; `run` runs free only when its leading program is on the
  target's allowlist; `write` and `upload` always ask; a target with agent access
  off is denied. An `ask` is answered by the harness approval surface with
  English and Chinese text naming host, path, or command, and a profile without an
  approval service turns an `ask` into a denial rather than a pass. A command that
  pipelines, redirects, or substitutes has no single leading program, so it is
  asked about rather than pattern-matched.
- **File transfer over `scp`.** Upload and download take the same trust and
  credential flags as probes and commands (including `-P` for the port and the
  askpass environment for a stored password), refuse to start a copy that exceeds
  the transfer ceiling after stating the remote size, ask for `recursive` on a
  directory, and refuse to clobber an existing local file unless told to overwrite.
  Directories move with `scp -r`. `rsync` is not assumed: this machine has none.
- **A hard local boundary.** A transfer's local path is resolved against the
  conversation's own workspace and anything outside it — including a `..` walk —
  is refused before a child starts.
- Storage format 3: `agentAccess` and `allowedCommands` per target, per-target
  `remoteTimeoutMs` / `maxOutputBytes` overrides, ceilings `remoteTimeoutMs` and
  `maxTransferBytes` in the shared settings (editable on the Client settings tab),
  and the `sessions` table. Formats 1 and 2 keep reading, and removing a target
  clears the conversations that pointed at it.

### Changed

- `src/ssh.ts` became `src/transport.ts`: one option builder, one lane counter
  (probes, commands, and transfers share the ceiling of four concurrent
  operations), and one child lifecycle that terminates and drains before reading,
  so every action inherits the 0.5.1 fixes.
- The route gained `run`, `upload`, `download`, `setSessionTarget`, and
  `clearSessionTarget`; `list` now answers with this conversation's chosen target
  and the ranges every numeric field accepts.
- A call that needs a secret refuses with `secret-error` before any child starts,
  and a refused remote path is explained in words instead of a schema dump.

### Notes

- The tool and the storage change live on the Host side, so a running Harness
  keeps the previous module until it restarts; the page and the composer seat
  update through HMR on their own.
- The plugin claims the tool name `remote`; if another bundle holds it, this one
  registers `ssh_remote` and says so. The registry is probed before the claim, and
  a probe-to-register race retries once.
- Not done in this release: a custom chat card for the tool (the default row shows
  the transcript text), a PTY or interactive session, background remote jobs
  through `ctx.jobs`, and firing the `fs/write-intent` waterfall for a download —
  inside a git workspace the file still shows up in the turn's change summary, but
  outside one it is not recorded as a session file edit.

## 0.5.1

### Fixed

- **A first connection to an unknown host no longer times out.** A secret-backed
  probe ran with `BatchMode=no`, so on an unknown host key OpenSSH asked
  “are you sure you want to continue connecting (yes/no/[fingerprint])?” — on a
  terminal the spawned child does not have, with stdin ignored. Nobody could
  answer, the probe sat until its deadline, and stderr stayed empty, so the page
  could only report 无法连接 / timed out for a host that was actually reachable.
  Every probe now passes `-o StrictHostKeyChecking=accept-new`: an unknown key is
  recorded on first contact and the exchange proceeds. A **changed** key still
  fails, and is reported as “host key not trusted” rather than a generic failure.
- **A timed-out probe states what it saw.** The output readers were consulted
  before the provider had terminated the child and flushed the pipes, which left
  the timeout outcome with an empty reason. The runner now waits briefly for the
  child to settle and reads the streams after that drain.
- **The connect phase no longer eats the whole deadline.** `ConnectTimeout` was
  set to the full probe timeout, so a host that took its time on key exchange or
  authentication had nothing left and was cut off mid-handshake. It is now a
  third of the deadline, capped at 10 s: an unreachable host still fails fast.

### Added

- The Client settings tab shows a **Probe identity** card: the account, uid, and
  home directory the Host process runs probes as, reported by the Host. This is
  the answer to “my terminal connects but the page says it cannot”: the two are
  usually different accounts, so they read different `~/.ssh/config`, keys,
  agents, and `known_hosts` files.

### Notes

- Verified against the reporter's own target (`root@10.100.1.205`, password mode,
  a stored password) from this machine: with the 0.5.0 options the handshake hung
  12 s with no output; with `StrictHostKeyChecking=accept-new` the same command
  authenticated in 681 ms with exit code 0.
- The plugin records an unknown host key in the **Host account's** `known_hosts`,
  which 0.4.0 documentation said it never touched. That promise is corrected in
  both detail documents.

## 0.5.0

### Changed

- **Two authentication modes instead of three.** The picker offers **Key** and
  **Password**; the `Key + password` choice 0.4.0 introduced is gone, because it
  was a middle ground OpenSSH already provides inside the key mode: fill the
  passphrase field and the same askpass path answers it, leave it empty and the
  agent or an unencrypted key is used with `BatchMode=yes`.
- The write path rejects `key+password` (`save` and a draft probe both fail as
  `bad-input` on the `auth` field), while the read path still accepts it, so a
  record that carries it — from 0.4.0 or from a hand-edited JSON file — keeps its
  row label and probes with exactly the options it always did, instead of turning
  the whole list into a `storage-error`.
- The form therefore shows the key file and passphrase fields only in key mode
  and the password field only in password mode, and the strip has two segments.

### Notes

- The record format stays at `version: 2`; nothing is migrated. No target had
  been saved when this shipped, so in practice no stored row carries the removed
  mode — the tolerance is for hand-edited files and for the general rule that
  other readers meet what was written earlier.
- `askpass.ts` and the credential-record layout are untouched: a password still
  lives as a `grant` record at `ssh/<target>-password`, and a passphrase at
  `ssh/<target>-passphrase`.

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
