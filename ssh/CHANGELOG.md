# Changelog

All notable changes to `@jie2gg/dsh-plugin-ssh` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## 0.16.0

### Added

- **A long remote command can be left running.** `exec` takes `background: true`: the
  command starts, the call answers at once with a job id (`ssh-…`), and the
  conversation reads and stops it with the harness's own **`job_output`** and
  **`job_kill`** tools — partial output arrives incrementally from the provider's own
  stream cursors, a completion notice is delivered when it settles, and a progress line
  is available while it runs. Nothing new to learn: it is the same job surface a
  backgrounded shell command uses, so `job_list` shows it too.
- A backgrounded command keeps the **same permission rules** as a foreground one: the
  allowlist and the ask-if-unlisted behaviour are unchanged, and naming a target still
  records it for the conversation.
- The started result says plainly what to do next and no longer claims an exit code the
  command has not produced yet.

### Fixed

- **A well-formed background call was rejected by its own schema.** The tool forwards
  the job registry's bookkeeping (`callId`, `rootCallId`) alongside the command, and
  `execBackground` handed that whole object to the strict run schema, which answered
  `Unrecognized keys: "callId", "rootCallId"`. The identity is now read off before the
  run input is validated, so the ids land on the job record where they belong. Found by
  running it against the live server, which is also how the job tests got honest: the
  fake registry had never been calling `run`, so three of its assertions were measuring
  a path that did not execute.

### Notes

- **A stopped job is reported as stopped.** Killing the local client makes `ssh` exit
  255, the same code as an ordinary connection failure, so a cancelled job settled
  `failed · exit=255` and the reader had to guess that it had asked for the stop. The
  intent now decides the classification: a requested stop settles `killed`, naming the
  reason, and says what the client exited with in passing.
- **`job_kill` interrupts the local connection, not the server.** The remote command
  normally dies when the session closes, but that is the server's choice, not a promise
  this plugin makes. A command that must be certain to stop on the server needs its own
  pid recorded and killed, which `exec` can do.

- What this does **not** buy: the connection lives in this process, so stopping the job,
  the conversation ending, or a Host restart ends the remote command — nothing is
  double-forked on the server, and there is no shell to type into. A command that needs
  to survive on its own still wants `nohup … &` or a systemd unit, which `exec` can
  write for you.
- A running job occupies one of the plugin's four concurrent remote operations, and the
  deployment caps active jobs per conversation (ten by default). Both are reported as
  refusals rather than queueing silently forever.
- Backgrounding is refused in a profile with no job registry, with a hint to drop the
  flag; the registry is read through `ctx.get`, so the plugin still activates without it.

## 0.15.0

### Added

- **`exec` can give the command a terminal and an answer.** `tty: true` runs it under
  `ssh -tt`, which is what a command that inspects its own output needs — `sudo`
  typing a password, a colourised listing, another ssh hop — instead of waiting for a
  terminal that was never there. `input: "…"` feeds the command's stdin, so a prompt
  can be answered or a body piped in without a shell heredoc. Both are reported on the
  result (`tty`, `stdinBytes`) and stated in the transcript line, including the trade:
  under a pseudo-terminal the server merges stderr into stdout and ends lines with
  CR-LF.

### Fixed

- **Arguments the caller sent were silently dropped.** The defensive reader mapped
  only part of the surface it declares, so a field added later — a transfer's
  `localPath`, an `edit`'s `oldText`, the new `tty` and `input` — arrived as though the
  caller had omitted it: an upload prompt rendered `Upload <local path>`, and a
  well-formed `edit` would have been refused for a missing needle the caller had in
  fact passed. Only a live call could show it, because the offline suites handed the
  dispatch pre-built arguments. `readArgs` now maps every declared field, and a new
  suite section calls the reader directly: each field is checked to survive, an explicit
  `false` stays `false`, an empty `input` stays distinguishable from an omitted one, a
  wrongly typed value is dropped rather than coerced, and the upload and edit prompts
  are asserted to name what the caller actually passed.

### Changed

- Two parameter descriptions in the tool schema still spoke of `run`; they say `exec`.

## 0.14.0

### Added

- **`edit` changes a remote file by exact text, not by line number.** It reads the
  file, applies the replacement locally, and writes the result back through the same
  inode (`cat >`, so owner and mode survive), leaving a `<path>.dsh-bak` copy unless
  `backup: false` is passed. A needle that matches more than once is **refused** with
  the count and the two ways out (`all`, `replaceFirst`, or more surrounding lines),
  because on a server there is no diff view in which to notice a wrong guess. A file
  larger than the read ceiling is refused rather than edited blind.
- The matching rules live in `src/edit.ts` as a pure function, so the semantics —
  non-overlapping counting, byte sizes rather than characters, an empty `newText`
  meaning deletion, a no-op replacement refused — are tested without a server.

### Fixed

- A **refused** edit no longer reports a replacement count. The ambiguous case reused
  `replaced` for the number of matches, so the transcript read `replaced 2 places`
  immediately above `That text appears 2 times` — the opposite of what happened. The
  refusal now carries `matches`, and the line says `matched 2 times, so nothing was
  written`. Found by the first live ambiguous edit against the server.

### Changed

- **Two action names became verbs of what they do.** `targets` is now
  `get_connection`, and it answers the question the call is really for: which server
  a later call would address, and how that was reached (named in the call, remembered
  for this conversation, or the only one saved). Nothing connects while it answers.
  `run` is now `exec`.
- **`ls` is gone: one `read` answers whatever the path is.** A directory comes back
  as a listing, a file as its text, anything else (symlink, socket) as what it is,
  and a miss as a refusal that names the parent directory as the next step. The tool
  has one fewer decision to make and the model one fewer name to remember.
- The read is still **one round trip**: the remote shell tests the path and prints a
  marker line naming the case (`ssh-plugin: file 4096`) before its body, and the
  plugin splits that line off. The reported size is kept apart from the bytes that
  actually came back, so a read clipped by the output ceiling can say *how much was
  left behind*. An answer with no marker is treated as plain file text rather than an
  error, which is what a shell that could not run the test would have produced.

## 0.13.0

### Changed

- **The tool is now `ssh_client`.** `ssh` is the word the OpenSSH program owns:
  in the same sentence the description talks about the executable, the `-G`
  resolution, the askpass helper, and `scp`, a tool named `ssh` reads as the
  program rather than as this plugin's client over it. The fallback when another
  bundle holds the name stays `ssh_remote`.

## 0.12.0

### Changed

- **An empty command allowlist now reads as what it is.** The line the model sees
  said `allowlist=none(ask every command)` and the description implied a program had
  to be listed to run freely — both written before 0.10.0 made an empty list mean no
  restriction, and both would have nudged the model to avoid `run`. It now says
  `allowlist=none(no restriction)` and explains that a target with a list is the one
  that gates.
- **The tool is called `ssh`, not `remote`.** `ssh` is the word a reader and the
  model already use for it, the plugin is `ssh`, and a verb-shaped name invited the
  question "remote from what?". If another bundle holds `ssh`, this one still falls
  back to `ssh_remote` and says so once.

## 0.11.0

### Removed

- **The plugin no longer draws its own tool card.** The `tool.call.toolview`
  registration is gone, so a `remote` call renders in the harness's standard tool
  row exactly like every other tool's call — same icon column, same disclosure,
  same 查看轨迹 affordance — and the seat's component, copy, and styles left with it.
  Claiming the key had meant replacing the generic row outright, which put the
  plugin in charge of chrome it could not make agree with the rest of the
  transcript.

### Notes

- What the model and the reader see is unchanged: the outcome facts live in the
  transcript text the tool renders (`proxy$ <command>`, stdout, `[stderr]`,
  `status=… · exit=… · 705 ms`), which the standard row displays verbatim.

## 0.10.0

### Changed

- **A session that cannot ask you no longer refuses itself.** Full workspace
  permission and the approval prompt are two different switches: a conversation
  whose approval policy is `never` resolves every request as *rejected*, and the
  core decides that before dispatching `approval/request`, so no listener — the
  plugin's gate included — can turn it into a consent. Previously `run`, `write`,
  and `upload` were therefore refused in exactly those sessions, which read as a
  connection problem rather than a policy one.
- The gate now reads the same policy the approval service would apply — the
  session's logged override, then the service default, then `ask` — through an
  optional `ctx.get('approval')`, so a profile without the service still gets the
  tool. When nobody could answer, the call runs; a `deny` stays a `deny`, because
  that one is your own switch on the target, and a policy read that throws falls
  back to asking.

### Notes

- Consequence worth stating: in a session that will not ask, a command allowlist
  becomes advisory — it decides nothing you can observe. `agent access off` per
  target is the switch that still means no.
- New module `src/approval.ts` holds the precedence read, exported so the ordering
  is asserted directly instead of being assumed from the service's source.

## 0.9.0

### Changed

- **The model picks the server, not a menu.** The tool description names every
  saved alias with where it goes — `` `proxy` (root@10.100.1.205)`` and so on — and
  says to choose the one the conversation means; the `target` parameter repeats the
  list. Add a server and the agent's choices follow, without a hand-picked default.
- The composer's session-options row (**Remote server**) is gone — seat, component,
  and copy: choosing a target in the input area was the wrong shape for a capability
  the model can route itself.
- **The conversation remembers what the model chose.** A call that named a target
  records it as that conversation's default so the next can leave `target` out; a
  call that resolved through the stored default or a lone saved server records
  nothing, and a failed record never fails the remote call.

### Added

- `registerRemoteTool` answers with a `{ name, dispose }` handle instead of a bare
  name, because keeping the alias list honest means re-claiming the tool: the
  parameter DSL takes static strings and `defineTool` projects them once, so a thunk
  would freeze anyway. The inventory is cached at registration time and the tool is
  re-registered after every save or remove.

## 0.8.0

### Added

- **A downloaded file now counts as a change in the conversation.** Before `scp`
  writes anything, the plugin dispatches the same `fs/write-intent` waterfall the
  built-in file tool does, with the live tool execution as the actor, and the
  session's change recorder captures the before-image from that event — it never
  watches the write itself, so an external process producing the bytes is the
  supported shape, not a workaround.
- The plugin honours what the pipeline answers instead of ignoring it: a
  `createIfAbsent` guard with a file already in place refuses the download and
  names the file pipeline as the reason, and a `replaceIfVersion` requirement is
  reported as such (an external copy cannot re-check an opaque version token), so
  a forced overwrite is an explicit caller choice rather than a silent bypass.

### Added (also 0.8.0)

- **The remote tool has its own chat card.** Registering the wire name in the
  `tool.call.toolview` keyed seat replaces the generic tool row completely, so the
  card covers every phase — a pending line while arguments stream in, the headline
  plus a running state once dispatched, and outcome chips with an expandable output
  body at result — and every action. The headline names the target, the action, and
  the path or command; a fetched or written local file gets a button that opens it
  in the editor, and the trajectory inspector stays available. Both possible wire
  names are claimed (`remote` and the `ssh_remote` fallback); the one never
  registered simply never renders.
- The card's metadata stays three scalars on purpose: the output DSL infers a
  strict `JsonValue`, so status, exit code, duration, and byte count are read back
  out of the transcript line this plugin itself renders, which keeps the two in
  step without widening the persisted payload.

### Notes

- Attribution follows the recorder's own rules: only the turn's first mutation of
  a path gets a before-image, and delegated or subagent sessions are skipped. The
  plugin does not emit `fs/observed` after a transfer — nothing reads it for the
  change list, and the version token belongs to whoever performs the write.

## 0.7.0

### Added

- **A **Resolve** button on every target row.** It asks the local OpenSSH client
  what that address actually means (`ssh -G`, which applies `~/.ssh/config`,
  canonicalisation, and defaults **without contacting the server**) and shows the
  host it would dial, the port, the user, the identity files in the order they
  would be tried, and any `ProxyJump` or `ProxyCommand`.
- A **differs from the saved address** chip when the client resolves something
  other than what you typed — which is the usual reason an alias works in one
  account's terminal and not here: the resolution is done as the Host account, the
  same account that runs the probes, so it shows that account's configuration.
- The raw resolved output stays available in a collapsible panel, so nothing is
  hidden behind the parsed subset.
- The route gained a `resolve` method (`{ target?, sessionId? }`), and
  `SshTransport.resolve` shares the lane accounting, the executable lookup, and the
  drained-stream reading of every other call — its command line deliberately
  carries no `BatchMode` and no remote command, because nothing connects.

### Notes

- A saved record that names no user and a resolution that supplies one counts as a
  difference: the probe would dial a bare alias and let the client decide, so the
  panel telling you the effective user is the point of the feature.
- Verified offline against a canned `ssh -G` dump: the `-G` form is local-only
  (no `BatchMode`, no trailing remote command), the six keys are parsed with
  repeated `identityfile` lines preserved, the differs flag is true for a
  redirecting alias and false for an exact match, a nonzero client exit becomes
  `ok: false` with its message, and an empty inventory refuses with `bad-input`
  naming the reason. 394 assertions across seven suites.

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

### Fixed (0.6.0, found in live use)

- The tool rejected its own successful calls: `read` and the two transfers
  matched **no** `oneOf` branch, so the registry reported
  `value must match exactly one oneOf branch (matched 0)` on a call that had
  actually worked. Two causes: the per-branch schemas omitted `exitCode` and
  `durationMs`, which every ops method emits, and the transfer branch pinned
  `action` to the name `transfer` while the body returns the real action
  (`upload` or `download`). Both are corrected — the common outcome fields moved
  into the shared shape and the transfer branch declares the actions it serves.
- A **download copied from the local filesystem**: `transfer()` built the
  `host:path` argument only for uploads, so a download passed the bare remote path
  and `scp` reported the server's path as a missing *local* file
  (`cp: 对 '/tmp/…' 调用 stat 失败`) even though `read` of the same path had just
  succeeded. The far end is now named the same way in both directions, and the
  suite asserts the download argv (remote spec, then the workspace destination)
  instead of only the upload one.
- Transfer reporting: a successful download now states the byte size it had
  already measured in the pre-check, an upload omits `bytes` rather than inventing
  it, and the "an existing destination was replaced" note no longer rides on the
  byte line (so it appeared only when a size happened to be known). Live use showed
  a replaced download rendering without any hint that it had overwritten.
- The offline suites had asserted the payload *values* without ever validating
  them against the projected JSON Schema, which is how this survived 71 tool
  assertions. Section 5b of the tool suite and 5b of the transfer suite now run
  every action's payload through the registry's own `validateJsonSchemaValue`,
  plus two negative cases (an undeclared field and an unknown action must still be
  rejected), and both transfer directions now assert the built command line, a
  successful download asserts its reported size, and the replaced-destination line
  is asserted on its own. A refusal that never reached a target no longer invents a
  host name in the transcript line. 383 assertions across seven suites.

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
