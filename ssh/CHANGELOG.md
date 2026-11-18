# Changelog

All notable changes to `@jie2gg/dsh-plugin-ssh` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## Versioning scheme — synced to the repository's three-segment rule

The repository now fixes each segment's meaning: `major` = 大版本, a breaking
line decided by the user; `minor` = 用户认可版本, moved up only when the user
accepts the accumulated work, with `patch` reset to zero; `patch` = Agent 自动
迭代版本, one step per completed round of changes. No entry below was ever
user-accepted, so this plugin folds its history into the patch segment: at
adoption the version became **0.0.16** (16 iterations, zero user-blessed lines).
Historical headings and old numbers (`0.1.0` … `0.16.0`, `0.5.1`) keep their
pre-rule numbering — an old `0.N.*` maps to iteration `N` — and this adoption
is a remapping, not a new round. The first change under the new scheme is
`0.0.17`; the first user acceptance moves the line to `0.1.0`.

## 0.0.35

The release-readiness round the 0.0.34 report left open: an answer built on a byte
count is not an answer about content.

- **Fixed — a same-length, different-bytes body is no longer read as a successful
  edit.** The read now takes the file's SHA-256 alongside its version token; the
  write re-measures it before truncating (a rewrite that landed in the gap between
  this call's read and its write is refused `stale`, at any length) and again after
  — a body that arrives at the right size and the wrong content exits 28, is put
  back from the safety copy, and comes home as `restored: true` only because a
  digest vouches for it. Results carry `verdict`, `contentVerified`, and `sha256`.
- **Changed — a server with no checksum tool is no longer believed on size alone.**
  Where 0.0.34 reported success when the byte count matched, 0.0.35 writes the
  file, keeps the safety copy, and ends the call `ok: false` with
  `verdict: 'unknown'` and `contentVerified: false`. Fail-closed by intent: a
  length cannot prove content, and a caller that treats `unknown` as applied is
  the exact mistake this round set out to remove.
- **Fixed — the repair child states its evidence, and only evidence counts.** A
  restore that this server could only weigh is reported `unknown`, not `restored`;
  a repair that never answered says so instead of naming a verdict it did not
  receive. The safety copy is dropped only on a path a digest confirmed.
- **Corrected — what a copy's `timeoutMs` actually bounds.** The parameter promised
  “the whole budget the copy gets, pre-check and publish included”, and a live
  server disagreed: a 1.5 s upload whose publish step stalled on a readerless pipe
  answered 3.651 s later, because the pre-check, the copy and the publish are three
  remote children and each gets that clock. The behaviour is the one worth keeping
  — a publish cut in half is worse than a publish refused — so the words moved:
  the description now says the number bounds **one remote child**, and both DETAIL
  languages carry the measured figures.
- Tests: `tests/edit-shell.test.mjs` runs the generated POSIX sequences under a
  real `/bin/sh` — collision at equal length, no-digest server, a copy that cannot
  be written back, a tampered copy, a concurrent same-length rewrite — and the
  ops- and tool-layer fakes now speak the marker protocol instead of being told
  the answer.
- **Pinned in words — what the spill budget promises, and what it does not.** The
  per-Host-process ledger (1 GiB across 64 files) is a stopping condition on the
  *asking*, not a cap on bytes already on their way: a grant is never trimmed to
  what is left, and one child's two faces draw on the same grant, so the total is
  allowed to pass the threshold by the faces in flight when it tipped — near
  3 GiB at the shipped defaults rather than exactly 1 GiB. No number moved this
  round (the design draft's 256 MiB never reached the code, and changing a budget
  without a product decision is not this round's job); the prose around it did,
  and the constants, the refusal after the tip, and the fact that a second
  transport starts with a clean ledger are now anchored by tests.
- **Pinned in words — a copy turned away by a full transfer lane.** An `upload`
  or `download` that finds all its slots taken answers in the same vocabulary as
  any other refused copy — `status: 'failed'`, the lane quoted in `message`, the
  way out in `hint`, nothing moved — rather than throwing, and that has been the
  behaviour since 0.0.34 without being written down. It is tested at each surface
  that can answer differently: the transport refuses before a child is asked for
  bytes and gives the lane back whole after success, failure, a timeout and a
  cancellation; the copy layer carries the busy sentence through intact; the
  settings surface and a direct transport caller still get the thrown `busy`
  error (409 over rpc).

## 0.0.34

The round the 0.0.33 report left open: the transfer ceiling had to stop being a
photograph of a `stat`, the copy lane had to be countable, the edit had to keep
its promises when the write went wrong, and the temp files this plugin leaves
behind had to stop accumulating. No tool parameter or output field was removed,
no stored record format changed, and the RPC surface was left alone.

### Added

- **A byte ceiling that is enforced while the bytes move.** One file now travels
  through an `ssh` channel — `cat` on the far end, this process's counter on the
  near one — instead of through `scp`, which moves bytes without telling anybody
  how many. A copy that crosses the ceiling is stopped: the pump ends, the child
  is taken down through the provider's managed range, and the answer is
  `refused-size` quoting the bytes that arrived. An upload stopped by its ceiling
  never sends the end of file, so the far end cannot mistake a partial body for a
  complete one, and it never reaches the step that would move it into place.
- **The upload's landing order.** The bytes land in a sibling temp file on the
  server and only then take their final name — *through* an existing file, which
  is what keeps the inode, the owner, the mode and every hardlink pointed at it
  (the behaviour `scp` had, measured on a live server), or by rename with the
  source's permission bits filtered through the server's umask for a fresh name.
  A refused upload removes its own temp; a publish that failed leaves the complete
  bytes where they are and names the path in the answer.
- **`limitMode` on every transfer result**: `in-flight` for one file, `pre-check`
  for a tree. The two are different promises, and the field is in the payload and
  the transcript rather than only in a document a reader may never open.
- **A recursive download is enumerated on the server before it copies** — file
  count and cumulative bytes, with a probe that tells a server without GNU `find`
  apart from a directory that really is empty — and what landed is walked and
  reported afterwards, so a tree's numbers come from somewhere honest.
- **The guarded edit.** The read now asks for the file's version (inode, size,
  nanosecond mtime) in the same round trip; the write compares it in the same
  shell that truncates, and stops with `stale: true` when something else wrote
  first. A safety copy is taken before any truncation — including for
  `backup: false`, which now means "leave nothing behind" rather than "bet the
  file on the channel" — the write reports the size it had to leave, and a repair
  child looks at the file before touching it and answers with one of four facts:
  landed, intact, restored, or unrecoverable. New payload fields: `stale`,
  `restored`, `versionChecked`; the repair runs on its own short clock, because a
  reader who cancels an edit stops the edit and not the file's claim to be whole.
- **A spill budget per Host process.** 1 GiB and 64 files, against a per-stream
  ceiling the provider could otherwise be handed sixteen slots times two streams
  of. A grant is never cut down — a spill file the provider runs out of room for
  is deleted, which is the one outcome worse than no file — so the budget stops
  the *next* child, and the answer says so in its notes and in the transcript line
  that used to blame the configuration for what the budget decided.
- **The temp namespace is collected.** The askpass and control-socket directories
  now carry the process id that made them, a sweep at startup collects what a dead
  id left, a legacy name is judged by the idleness of the *helper* rather than the
  age of the directory, a socket whose master still answers a connect is never
  touched, and a helper taken from under a running Host is rebuilt on the next
  read (and using it keeps its timestamps young).
- **The transfer lane is countable.** `transfersInFlight` and `laneUsage(kind)` on
  the transport, `pool.transfers` in the list payload, and the settings card now
  prints each ceiling beside what is standing in it: operations, shared
  connections, copy slots. `get_connection` answers with the live copy count too.
- **A ninth background job is refused in its own frame.** `laneRoom` asks whether a
  reservation has room without taking it, and `execBackground` consults it before
  registering: `status: 'refused'`, no id, the ceiling in its words. The
  reservation, the ceiling, and the job lifecycle are unchanged.
- **`scripts/live-check.mjs`**: the same boundaries driven against a live server
  with the real DSH subprocess provider and the stored credentials — 86 checks,
  including a growing source that passes a pre-check of 0 bytes, three copies
  racing two slots, an overwrite measured by inode and hardlink, a concurrent
  writer refused 6 times in 6 attempts, and a sweep against the machine's actual
  residue.

### Changed

- `transfer()` no longer takes the askpass face it never read, and
  `ops.askpassSource()` went with it; the option builder owns that failure.
- A tool call's declared budget is computed by `transferCallCeiling` — pre-check,
  channel, publish and cleanup each with their own grace and drain — instead of
  one deadline plus a pre-check.
- Remote paths go through `remotePathArg` everywhere, which is also what makes
  `~/` work; a `mkdir -p` is no longer issued against the home directory itself.
- Ceiling notes are merged into a result's notes rather than replacing whatever the
  child already had to say.

### Fixed

- **`~/` paths were accepted and then never expanded.** The schema allowed the
  form, `shellQuote` wrapped it whole, and a live read of `~/f.txt` answered
  `Nothing at ~/f.txt` for a file that exists. A tilde-prefix ends at an unquoted
  slash; the `~/` now stays outside the quotes and the rest stays inside, measured
  under `sh`, `dash` and `bash`, for a read and for a redirection.
- **A recursive download into a directory that was not empty destroyed the tree it
  had just copied.** The part sibling renamed onto a non-empty directory, got
  `ENOTEMPTY`, and the cleanup deleted the finished copy — so the reader got a
  failure and no data. It is refused before a byte moves, and the file that was
  already there is named back untouched.
- **A copy whose child died by signal was treated as finished.** `exitCode: null`
  satisfied the `?? 0` success test; an interrupted download was renamed into place
  with a short file. A raw stream now ends "cleanly" only when it read to EOF, and
  an answer of `null` is no longer read as a zero.
- **The upload's mode arithmetic ran differently in every shell.** The nested
  substitution `chmod "$(printf '%o' $(( … ) ))"` the first cut shipped does not
  parse under `sh` or `dash`, and under `bash` handed `chmod` an empty argument and
  landed the uploaded file on mode `000`. Three assignments and a guard, measured
  under all three shells.
- **The spill budget charged streams that never spilled.** Ordinary answers ate
  the budget, so the child that actually needed a file was the one refused.

### Notes

- 240 offline tests pass (169 before this round); the new ones were reverse-checked
  by taking each fix out again — dropping the ceiling check, ignoring a stopped
  copy's child, refusing to map `over-limit`, skipping the write pre-check,
  ignoring the helper's timestamps, dropping the rebuild, and neutering the budget
  each fail named tests rather than quiet ones.
- A recursive copy is still bounded before it moves, not while it does: `scp -r`
  cannot be counted, and carrying a tree through `tar` would quietly change what a
  symlink means. The payload says which kind of ceiling answered.
- The version guard shrinks the window between noticing a change and making one to
  two shell builtins; it does not close it, and the README says so instead of
  implying a transaction.
- Spill files stay the subprocess provider's: it creates them, closes them, and
  keeps completed ones until something outside the process cleans them. This
  plugin counts what it asked for and unlinks nothing.
- One live finding shaped a default: the first version of the sweep collected a
  long-running Host's askpass helper because its *directory* was thirteen hours
  old. The idle rule now reads the helper's own timestamps, the horizon is three
  days, and the rebuild-on-read means a mistaken sweep costs a re-created file
  rather than a password prompt.

## 0.0.33

Phase 2D: the one defect the deployed 0.0.32 showed in the field — the `edit`
preview previewed everything except the server. Reproduced twice against a live
Host: an `ssh_client` call with `dryRun: true` came back having written the
file and left a `.dsh-bak` behind, because the tool layer never handed the flag
down.

### Fixed

- **`dryRun: true` now reaches the operations layer.** 0.0.32 shipped the whole
  preview branch in `ops.editRemote` and declared the parameter in the schema,
  but the edit case in `tool.ts` assembled its params without the field:
  `RemoteCallArgs` never declared `dryRun`, so the line that would have
  forwarded it failed the type check and simply was not there, and the missing
  declaration is how a dropped boolean survived review. The fix is the
  interface field, the one forwarded flag at the seam, and the `readArgs`
  mapping the interface's own comment has always demanded. Absent and an
  explicit `false` keep the plain write path exactly as it was, and `all`,
  `replaceFirst`, and `backup` ride through unchanged.

### Notes

- The regression now lives where the defect was: the executor's edit case, the
  real `ops.editRemote`, and a fake transport that plays the server — the
  file's bytes, the backups taken, and the write count are asserted as facts,
  not inferred from the payload. Pulling the forward line out of the built
  module makes the preview tests fail; leaving it broken made every ops-level
  suite stay green, which is the gap that let 0.0.32 ship a preview that wrote.
- 169 tests across the shipped suites green; `tsc` clean; no schema, no
  wording, and no other action's behaviour moved — the texts already promised
  "no write, no backup", and from here they tell the truth. Version
  0.0.32 → 0.0.33, pending its own re-verification on a real Host.

## 0.0.32

Phase 2C: the preview the plan asked for, the concurrency promise made true (or
told), and the dead code the review had already located in the source.

### Added

- **`edit` takes `dryRun: true`.** The match is found and counted under exactly
  the real rules — an ambiguous match refuses a preview as it refuses a write —
  the before/after byte sizes and a line diff come back, and nothing else
  happens: no write, no backup, no child beyond the read the preview needs
  anyway. `previewEdit` (in `edit.ts`, pure and tested) trims the unchanged ends
  and caps the diff at 80 lines, saying out loud when it cut short — a preview
  that dumps the whole file has stopped being a preview. No new insert/delete
  actions: an anchor-plus-empty-`newText` edit already says both, and the
  parameter now states that too.
- **A named `identityFile` now brings `-o IdentitiesOnly=yes`.** Without it, an
  ssh-agent holding several keys offers them first, and a server counting
  authentication attempts locks the named key out before it is tried —
  `too many authentication failures` has been in the classification table since
  the start, and this is the fix for its most common cause. No key named,
  nothing added; `extraArgs` land after and still override; the `ssh -G` view
  carries the same pair, so the resolve card shows what the children run.
- **The tool declares `isConcurrencySafe` — for the two reads only.**
  `get_connection` and `read` may join a parallel batch; every mutating action
  stays exclusive, because the harness contract asks whether parallel dispatch
  is safe and no remote filesystem here makes read-modify-write transactional.
  The model-facing sentence that used to promise "several can run at once" now
  states which ones, and a test pins the description and the classifier to the
  same claim.

### Changed

- **The RPC allowlist is the page's surface now.** `run`, `upload`, `download`,
  `setSessionTarget`, and `clearSessionTarget` had been mirrored into the route
  without any control ever invoking them; they are refused at the gate like any
  unknown name, and the `ops` methods behind them stay (the agent tool drives
  those directly). The README's route table matches what the page sends.

### Removed

- Dead weight the source could confirm dead, each with the check that found it:
  the `@deepseek-ai/dsh-output-retention` dependency (zero imports; spill has
  always come from the subprocess provider), `OpsDeps.options` and
  `FileCallOptions` (never passed by any assembly; the fallback they fed was a
  constant `undefined`), `resolveProbeTimeout` and `listSessionTargets` (no
  callers), `AskPassFace` (the transport's `AskPassSource` is the same contract
  in one place), the exported name `SSH_TIMEOUT` (internal since the fused
  deadline replaced hand-rolled guessing), an orphaned JSDoc block documenting
  a replaced `#collect` signature, the field-by-field job-source remap (both
  shapes were structurally identical; the map rebuilt the same object), and the
  five manual lane-release copies collapsed into the one `#releaseLane`.
- Stale wording: the `ls`/`run`/`targets` action names in model-facing and
  module comments (0.0.12-era verbs), and the storage comment claiming
  `agentAccess: off` "hides it from tools" — it never did, and does not: the
  target stays listed and every call addressed to it is refused, in words.

### Notes

- The edit write stays in-place `cat >`: the review's own §6 keeps the
  inode/owner/mode-preserving direction, and temp-plus-rename would trade that
  for atomicity the remote cannot guarantee anyway (a server-side change between
  the read and the write has no version check either way). The limitation is now
  stated in the tool, the README, and both DETAIL languages instead of being a
  silent property; `dryRun` carries the confirmation duty.
- The per-target ceiling layer (`remoteTimeoutMs` / `maxOutputBytes` on a
  record) stays, contrary to the review's R3 suggestion to drop it: it is
  reachable through a documented `save` payload, an existing test pins the
  layering through it, and Phase 2 promised no schema surgery. What it needs is
  a page control, which is a new-feature conversation, not a cleanup.
- 163 tests across fifteen suites green; `tsc` clean; the plugin's own check and
  test commands are `pnpm run check` and `pnpm test` (build plus the node
  suites); there is no separate lint configured in this package. Version
  0.0.31 → 0.0.32.

## 0.0.31

Phase 2B: the permission surface a human can actually reach, and the resource
reservations the ceiling numbers had been promising.

### Fixed

- **`su` and an `input` body are refused together, up front.** Both want the one
  stdin, the prompt reads first, and the old assembly silently spent the body's
  first line as the answer. The pair is now a `bad-input` refusal that says so
  and names the workarounds. The one combination that genuinely works stays
  working: `as` with no stored login password runs `sudo -n`, which never
  prompts — a NOPASSWD host takes the body intact, a prompting one fails fast,
  and neither path eats a line.
- **A master past `ControlPersist` stops being believed in.** The ledger kept
  counting masters OpenSSH had already closed and unlinked, so `liveMasters` —
  the settings card and the `list` payload — over-reported for as long as the
  process lived. `claim` and every read of the count now sweep: an entry idle
  past the persist window whose socket file is gone leaves the ledger silently
  (there is nobody left to send `-O exit` to), a socket that still answers keeps
  the entry, and the sweep re-stats at most every 30 s. A full ledger of expired
  beliefs no longer evicts — with a real teardown — the one live master a ninth
  call is standing behind.
- **The concurrent-dial race stopped killing its own winner.** Two first calls
  to one target used to have the late arrival print `ControlSocket … already
  exists, disabling multiplexing`, which the session table read as a broken
  master: the healthy winner was dropped from the ledger and `-O exit`-ed for
  nothing. That exact sentence is now recognized as the successful downgrade
  OpenSSH says it is; every other multiplexing complaint, and `already exists`
  without the fallback phrase (a stale socket), still reads as a fault.

### Added

- **The agent policy has UI.** `agentAccess` gained a checkbox and
  `allowedCommands` a text field in the target form, both sent explicitly on
  every save so turning access back on and emptying the list actually take
  effect; the list rows carry chips for `agent access off` and a non-empty
  no-approval list. The hints say what the field is — a list of programs that
  run without asking — and what it is not: not a sandbox, not a limit on
  arguments, not a check on pipelines. The two fields had been in the stored
  schema all along with no control reaching them; the docs had been promising a
  control that did not exist.
- **Jobs reserve foreground room.** `maxRunningJobs` (default 8, of the 16
  operation slots) caps how many *explicitly backgrounded* commands hold a slot
  at once — inside the existing lane counter, no second scheduler — and the
  refusal names the ceiling and points at `job_kill`. Foreground calls that
  might later promote are not counted against it, and the README now states the
  real 16 where it used to say four, alongside the job's lifetime bargain
  (settle, kill, owner gone, or Host exit).

### Notes

- Jobs keep no wall-clock deadline on purpose: a self-imposed guillotine would
  only mean a longer build died mid-flight, and the harness's own background
  shell makes the same bargain. The quota, not a timer, is what bounds their
  appetite for slots.
- `MuxPool` accepts an injectable clock so the expiry paths can be tested
  without sleeping through `ControlPersist`; the default is the wall clock.
- 155 tests across fifteen suites green; `tsc` clean. Version 0.0.30 → 0.0.31.

## 0.0.30

Phase 2A of the review follow-up: the reliability fixes the architecture review
identified, each with the tests the review listed as missing.

### Fixed

- **Cancelling a call now reaches the child.** `ToolDefinition.timeoutMs` is a
  promise — the contracts say declaring it asserts the tool forwards
  `exec.signal` — and the transport has long honoured an external signal, but
  nothing between the tool and it ever carried one. `exec.signal` now travels
  `tool.ts → ops → runner.run / startRun / transfer`, so cancelling the
  conversation (or the harness's own call budget firing) terminates the local
  ssh/scp child, releases its operation slot and pool lease, and is reported as
  `cancelled` — while a plugin deadline passing on its own is still `timeout`,
  by the fused-deadline first-cause rule. Started background jobs are the one
  case that deliberately does not forward: the job outlives the call that
  started it. The honest boundary stands: a killed local child does not
  guarantee the server-side command died with it.
- **Uploads are pre-checked at both ends.** A bare `scp` replaces a remote file
  without a word and copies whatever the local path holds; an upload now
  refuses a missing or unreadable local source, an oversized single file, a
  tree over `maxTransferFiles` or `maxTransferTotalBytes`, and — the silent
  data-loss case — an existing remote destination unless `overwrite` says
  otherwise. A recursive copy walks the same ceilings a single file faces,
  with a realpath-visited set so a symlink loop is walked once, and no check
  failure lets a partial copy start. These are pre-checks against what `stat`
  said at that moment, not gates on the bytes that move, and the docs say so.
- **A download lands by rename, not by accumulation.** The bytes go to a
  unique `…dsh-part-<pid>-<entropy>` sibling of the destination and are
  renamed into place only after a clean finish; cancelled, timed-out, errored,
  and refused-to-rename paths delete the sibling. A half-downloaded file no
  longer masquerades as a finished one, and a failed download cannot wreck a
  final file that was already there.
- **Transfers run on their own clock.** A copy of a permitted 500 MiB file
  under the command's 30 s default was dead on arrival on any slow link.
  `transferTimeoutMs` (default 5 minutes, capped at 30) is its own
  default-and-cap pair; the call's `timeoutMs` reads as "how long to wait for
  the copy", and results echo the transfer deadline rather than the command's.
  The declared tool-call budget now covers the longer of the two clocks.
- **askpass answers from the slot the prompt names — and only that slot.** The
  helper fell back across slots: a server asking for a key passphrase while
  only a login password was stored got the login password, burned the single
  allowed prompt, and reported the failure as `permission denied (publickey)`
  about a secret nobody had been asked for. Each prompt now reads its own
  environment slot; an empty slot answers empty and the method fails honestly.
- **`unavailable` approval no longer masquerades as consent.** The gate merged
  "the deployment says never ask" (full-access mode, respected as before) with
  "there is nobody to ask" (no approval service, or no session to route
  through). The latter now reaches the core as an ask, and the core answers
  with its fail-closed denial that names the missing piece. A remote write
  with no approval surface mounted is refused, not silently run.

### Added

- File transfers hold at most `maxConcurrentTransfers` (default 2) of the 16
  operation slots — a per-kind lane ceiling inside the existing slot counter,
  not a second scheduler — and the refusal names the ceiling it hit, so two
  large copies cannot starve every command.
- `scanLocal`, the walk behind the upload ceilings, and `TransferOutcome.files`,
  so a recursive upload reports what it measured before it moved it.
- Test suites that did not exist: `transfer.test.mjs` (both directions of the
  pre-checks, the temp-file dance, and its cleanup on every failure path),
  `approval.test.mjs` (the policy function the gate reads), `askpass.test.mjs`
  (the real shell script, every slot combination), plus lane-ceiling and
  16-slot-fill cases in `transport.test.mjs` and call-cancellation cases in
  `tool.test.mjs` and `ops.test.mjs`. 150 tests across fourteen suites green.

### Notes

- Phase 1's report matched the source on every one of these; the one place its
  prose needed reading against core code is `ApprovalPolicy = 'never'`, which
  the core resolves to *rejection of asks* — the plugin's gate choosing not to
  ask under `never` is this plugin's standing decision, documented and kept.
- No RPC method, storage shape, or tool action changed. New config fields
  arrive with defaults, so an old profile behaves as the new docs describe.

## 0.0.29

### Fixed

- **`upload`, `download`, `write`, and `edit` were rejected by the plugin's own
  output schema** — since 0.0.24. The bounds round stamped the numbers that actually
  applied (`bytesLimit`, `timeoutMs`, `notes`, and for file calls `outputBytes` plus
  the spill paths) onto results, the tool spreads the result into the payload, and
  the payload branches for those four actions still declared
  `additionalProperties: false` without the new fields. The registry therefore
  matched the payload against **no branch at all**: `value must match exactly one
  oneOf branch (matched 0)`.
- The damage was worse than an error message because of the ordering: the work had
  already been done before the payload was checked. A download copied the file, a
  `write` created it on the server, and *then* the reader was told the call returned
  invalid output — so the model could not see that its own action had succeeded, and
  the sensible retry duplicates a file write.
- `read` and `exec` were unaffected because their branches had been updated when
  those fields were introduced, which is how the failure looked partial and
  arbitrary.

### Notes

- Why the suite missed it, and what changed so it cannot again: the tool suite's fake
  `ops` returns hand-written results, and those fakes never carried the stamped
  fields — so the tests validated a payload shape production was not producing. The
  fakes for `upload`/`download` now return exactly what `ops` returns (echoed
  ceilings present, and an empty `notes` list omitted, because `ops` omits it), and
  the transfer case carries a real capping receipt so the declared field is exercised
  rather than merely allowed.
- Found by running it, not by reading it: this is the first live pass over the four
  file/transfer actions after the bounds change.
- 124 tests across eleven suites are green; `tsc` clean, `oxlint` 0 warnings and 0
  errors. Version 0.0.28 → 0.0.29 under the three-segment rule.

## 0.0.28

### Fixed

- **A handed-over command no longer claims its output was truncated.** The promoted
  result carried `truncated: true` to mean "the text you got is a part", and that
  collided with the word's actual meaning — a ceiling clipped a finished stream, and
  here the stream was still being *written*. Live check after the Host restart:
  a 600 ms call on a 3-second command answered
  `[output truncated; full output: (no spill file configured — …)]` over a spill
  budget that was happily configured and never needed, because the truncation
  sentence keys off that flag. The hand-over sentence now says what is true ("this is
  how far it had got; the job carries the whole stream from the beginning"), and the
  claim about a missing file is gone.
- **A cap that moved a number now reaches the text a model reads.** The effective
  ceiling and the correction travelled only as structured payload fields, so a call
  that asked for 900 000 ms and ran on 300 000 ms looked identical to one that got
  what it asked for — and the natural wrong move is to assume the *server* was the
  slow part. Each receipt is rendered as its own bracketed line
  (`[command timeout asked for 900000 and was capped to 300000]`).

### Notes

- The live round that found this also confirmed the rest of the plan against a real
  server, on OpenSSH with the plugin's own credentials: a promoted call returned
  `status=promoted · 622 ms` with the partial output, and `job_output` then delivered
  the whole stream (`first-line`, `second-line`) ending `exit=0 · 3377 ms` — the
  non-consuming offset readers mean the preview costs the job nothing. A 40 000-line
  command capped at 64 bytes kept only its tail in the answer while the provider wrote
  the complete stream to a `0600` file (228 894 bytes, `first=1`, `last=40000`), whose
  path the transcript named. And the ceilings line reads
  `command 30000–300000 ms, in force 30000 ms; … A number past the cap is capped to it,
  not refused.`
- 124 tests across eleven suites are green, including the two new assertions that a
  promoted answer makes no truncation claim and that a cap receipt is visible in the
  rendered text. `tsc` clean, `oxlint` 0 warnings and 0 errors. Version 0.0.27 →
  0.0.28 under the three-segment rule.

## 0.0.27

### Changed

- **One interrupted child, one cause.** The wait inside a call is now built from
  `deadline(caller signal, timeoutMs, SSH_TIMEOUT)` and read back with
  `timeoutOf`, both from `@deepseek-ai/dsh-timeout` — the same fused-deadline the
  harness's own shell uses, where `AbortSignal.any` adopts the reason of whichever
  side aborted **first**. The hand-rolled version it replaces decided between
  timeout and cancellation by checking the caller's signal inside its own timer
  callback, so a child stopped in the same instant as its deadline came back as
  whichever branch the code tried first. Now `timeout` means the server was too
  slow, and `cancelled` means the reader stopped it.
- A job arms **no timer at all**: `timeoutMs: 0` is the timeout library's own
  "no deadline" sentinel, so a backgrounded or promoted command waits on the child,
  the caller's signal, or teardown — not on a number this plugin made up. 0.0.26
  removed the 30-minute lifetime; this removes the timer that pretended to.

### Notes

- The `SSH_TIMEOUT` code is capability-owned, mirroring `BASH_TIMEOUT`: a nested
  deadline that fires first still reads as an upstream cancellation rather than as
  this plugin's own timeout.
- 124 tests across eleven suites are green, including two new ones: the
  timeout-versus-cancellation split on a child that never settles, and proof that a
  zero deadline really arms nothing. `tsc` clean, `oxlint` 0 warnings and 0 errors.
  Version 0.0.26 → 0.0.27 under the three-segment rule.

## 0.0.26

### Changed

- **A foreground command that runs out of time is handed to the job registry
  instead of killed.** The deadline belongs to the reply, not to the work — that is
  how the harness's own shell answers a timeout, and this plugin now answers it the
  same way: the command is started through the same untimed, job-capable path a
  `background: true` call uses, and the call waits on it. Settle inside the window
  and nothing changes; still running at the deadline and the call answers
  `status: 'promoted'` with the `job id`, the output produced so far, and a hint
  naming `job_output`/`job_kill`. Killing a 25-minute build at 30 seconds because a
  model asked once and waited used to mean starting that build again from nothing.
- `ok` is true for a handed-over call, deliberately: it is a call that succeeded at
  something, and a model reading it as a failure would retry work that is still
  happening.
- **A backgrounded command has no deadline of its own.** `BACKGROUND_DEADLINE_MS` is
  gone: a job lives until it settles, until `job_kill`, until its conversation goes
  away, or until the Host exits — holding one of the 16 operation slots the whole
  time, which is the honest version of "no timeout applies". The old 30-minute
  guillotine was the plugin inventing a bound the harness does not have.
- When the registry refuses the hand-over — usually that conversation already holds
  all ten of its jobs — the plugin falls back to what it did before, kills the child,
  and says the hand-over was refused and why, rather than reporting a plain timeout.

### Added

- `promoteOnTimeout` (default on) is now the config knob it was declared as in
  0.0.24: a profile that wants the old behaviour, or one with no job registry at
  all, keeps the plain bounded wait — still one code path rather than a special case.
- `startRun` accepts `stdin`. That is what makes an **elevated** command promotable:
  its sudo/su answer is injected at spawn, so the password channel is already closed
  by the time the deadline arrives — unlike a command *started* in the background,
  which still can't elevate and still says so.
- The provider's offset readers are non-consuming, so the partial output that comes
  with a hand-over does not steal bytes from the job: `job_output` still sees the
  stream from the beginning.

### Notes

- Two statuses now mean different things and are worded differently on the page and
  in the transcript: `timeout` (out of time, and no hand-over happened) and
  `promoted` (out of time for this reply, still running on the server).
- The `as`/`su` foreground-only rule is narrowed, not removed: what cannot be
  **started** in the background is an elevated call, because there is nobody to hand
  the password to; what can be **moved** there is one that already answered.
- 122 tests across eleven suites are green — five new ones cover the settled path,
  the hand-over with its attribution to owner and call, the refused fallback, the
  config opt-out, and a profile with no registry. `tsc` clean, `oxlint` 0 warnings
  and 0 errors. Version 0.0.25 → 0.0.26 under the three-segment rule.

## 0.0.25

### Changed

- **A truncated answer now points somewhere.** The subprocess provider has always
  been able to keep a stream's in-memory tail *and* write the complete stream to a
  file, given one thing in the request: `spill: { maxBytes }` on the stdio entry.
  Omitting it is documented as "keeps only the in-memory tail", and this plugin
  omitted it — so `maxBytes` ceilings used to mean "the rest is gone", and the
  result could only confess `[truncated]`. The transport now passes the configured
  spill budget, carries the reported path through the result, and says what the
  harness's own shell tool says:
  `[output truncated; full output — stdout: /tmp/dsh-subprocess-…/….log]`. A `read`
  clipped by the ceiling gets the same pointer, which for a big remote file is the
  difference between "ask again with a bigger ceiling" and "go read that path".
- **The two exceptions are named rather than smoothed over.** `maxSpillBytes: 0`
  configures no file at all, and the result now says so in as many words ("no spill
  file configured — raise `maxSpillBytes`, or ask for more with `maxBytes`"); a
  stream larger than the spill cap has its file abandoned by the provider, and the
  plugin does not promise a path that no longer holds the whole answer.

### Notes

- The path comes from the provider, in its own per-process `0700` temp directory
  with `0600` files — so the plugin invented no layout, owns no cleanup, and cannot
  collide with another user's socket or file. Those files live in the system temp
  directory, not in the conversation workspace: a downloaded file still appears in
  the change list, a spilled stdout does not.
- Background jobs were already carrying `spillPath` through their offset reads; the
  foreground path was the half that dropped it. Both now render the same sentence,
  so a model cannot meet two answers to the same question.
- `maxSpillBytes`, declared in 0.0.24's configuration table, is wired by this
  round; `promoteOnTimeout` is the one row still waiting (0.0.26).
- 116 tests across eleven suites are green, including a provider fake that pins the
  `spill` request itself and the zero-budget branch. `tsc` clean, `oxlint` 0
  warnings and 0 errors. Version 0.0.24 → 0.0.25 under the three-segment rule.

## 0.0.24

### Changed

- **The bounds model is now the harness's, not one this plugin invented.** The
  three ceilings carried two-sided ranges — `1 s – 300 s`, `1 KiB – 4 MiB`,
  `1 KiB – 512 MiB` — enforced with rejections, and a value outside them was an
  error rather than a decision. No harness tool works that way: `bash-local`
  declares a **default and a cap** as volatile config and *clamps* an override in
  `resolve()`, the shell seam echoes the effective timeout back, and `tool-jobs`
  caps a wait the same way while refusing at load time when a cap sits below its
  default. The plugin now does the same thing: `src/config.ts` holds a
  `{name}` / `max{name}` pair per ceiling (plus the probe deadline, the pre-check
  deadline, the spill cap, the kill grace, and the promotion switch), all live, and
  `src/bounds.ts` is the one place that resolves **call → target → profile override
  → configured default**, caps the result, and returns a receipt per correction.
- **A number past the cap is no longer a refusal.** An over-cap deadline, output
  ceiling, or transfer limit is now capped to the cap, and the value that actually
  ran is echoed in the result (`timeoutMs`, `outputBytes`, `bytesLimit`) with a note
  naming what moved. Only a value that cannot mean a deadline at all — zero, a
  negative, a non-finite number — is still refused, and the hint says where the line
  is now. The floor is gone on purpose: 500 ms is a decision someone can make.
- **The settings page edits overrides, not the truth.** Empty means "follow the
  configured default", `null` clears an override, and the card next to the fields
  is renamed from **Fixed bounds** to **Resolved bounds**, stating each ceiling as
  *in force / default / cap* so a reader sees the number a call actually met rather
  than one they hoped for.
- **The storage domain is version 6**, reading 1 through 5: the global slot's three
  ceilings became optional, because a default and a cap live in configuration now.
  Nothing migrates — a stored file with all three numbers reads on as three
  overrides, and a hand-written value outside the current cap stores fine and is
  capped where it is used, which is the only consistent story once saving is no
  longer the place bounds are enforced.

### Added

- `src/config.ts` (the plugin's first declared `Config`, so the bundle row's
  `config:` keys are read rather than ignored) and `src/bounds.ts` (resolution,
  capping, receipts). New reuse, not new code: `clampTimeout` comes from
  `@deepseek-ai/dsh-timeout`, and `@deepseek-ai/schemastery` supplies
  `.volatile()`, which is what makes a profile edit reach the next call instead of
  the next restart.
- A `bounds.test.mjs` suite over the resolution layer alone: layer order, what a cap
  does, what is refused, the raised-cap note, and the config schema filling
  defaults.

### Fixed

- **A `read` that asked for `maxOutputBytes` did not get it.** The per-call ceiling
  reached `exec` and transfers but silently not the file actions, and the old
  suite pinned that behaviour in place with a comment calling it a wart. Folding
  the file path into the same resolution as every other call fixes it: the value
  asked for is the value used (capped, and echoed).
- **The plugin's declared call budget used to equal its own internal cap**, both at
  300 s. `guard/timeout-policy` reads the declaration, arms its own timer, and
  **replaces whatever the tool returned** with `Error: tool call timed out after
  <N>ms` if that timer wins — so an ordinary remote timeout was a coin toss between
  this plugin's classified answer and a generic sentence. The declared budget is now
  derived (`maxTimeoutMs + graceMs + drain + 5 s` slack) with a test pinning the
  inequality, so the plugin's own answer always wins on a normal deadline and the
  wrapper is left to what it is for: a call that hangs with nothing to time out on.

### Notes

- Two of the new keys are **declared this round and wired in the next two**:
  `maxSpillBytes` (the provider already writes a full-stream spill file when asked;
  surfacing its path is 0.0.25) and `promoteOnTimeout` (0.0.26). The detail page
  says so rather than letting a table imply more than the code does.
- Raising `maxTimeoutMs` above the default cap needs a Host restart before the
  *declared* tool budget follows it, because registration fixed the number; the
  internal deadlines follow immediately. Documented in the config section and on the
  field itself.
- `bash` declares no call budget at all and never meets this collision; that is the
  alternative shape, and the reason to keep a declaration here is stated in
  `README.md` rather than left implicit.
- 114 tests across eleven suites are green; `tsc` clean and `oxlint` reports 0
  warnings and 0 errors. Version 0.0.23 → 0.0.24 under the three-segment rule.

## 0.0.23

### Changed

- **A connectivity test passes at login, not at the end of a command.** The page's
  test asks one question — can this credential get an authenticated session open —
  and now stops there. A call carrying a shared connection dials with `-N`:
  OpenSSH hands the authenticated master to the background, the foreground client
  has nothing left to do, and it exits on its own — measured against a live server
  at two tenths of a second for a first connection and a tenth over a warm one. A
  call that is dialing alone keeps running `true`, because `-N` with no master to
  leave behind sits on an idle session until its deadline: the page would wait
  thirty seconds to say yes. So the mechanism follows the lease rather than the
  target's settings, and a target with sharing switched off still answers the
  slightly wider question it always answered.
- **The probe deadline is thirty seconds, still fixed in code**
  (`PROBE_TIMEOUT_MS`: 10 s → 30 s). The connect phase keeps taking a third of it,
  capped at ten seconds, so a host nobody answers is still refused quickly, and the
  longer tail buys a slow link, a jump host, and a real authentication round
  instead of a false "unreachable".
- **The download's size pre-check has its own ten seconds** (`STAT_TIMEOUT_MS`).
  It used to ride on the probe deadline, so retuning one test would have quietly
  tripled the patience of a different one: one file's metadata should not be given
  a connectivity test's budget.

### Fixed

- **A background call refused before its child started no longer leaks an
  operation slot.** Building a call's options can refuse — a stored password with
  no askpass helper on this Host — and it happened after the slot had been taken
  and the lease claimed, so both stayed counted for as long as the process lived.
  When four slots were the whole budget one bad call was a quarter of the plugin;
  at sixteen it is a smaller hole, which is exactly why it got fixed rather than
  lived with.
- **The timeout hint told a reader to raise a setting that no longer exists.** The
  probe timeout stopped being a field in 0.0.18 and the hint kept pointing at it in
  both languages. It now says what is true: thirty seconds is fixed, a slow host is
  not a dead one, and the timeout you can set belongs to a real command.

### Notes

- One side effect of the new shape is worth knowing: a rejected credential is now
  named honestly. The live measurement of the same wrong password printed
  `Permission denied (publickey,password).` under `-N` and
  `Connection closed by … port 22` under `true` — which the tables classify as
  `auth-failed` and `unreachable` respectively, so the older shape could blame the
  network for a secret problem.
- The `Authenticated to … using "password".` marker this release could have waited
  for does exist in OpenSSH 8.4+ — but only at `LogLevel=VERBOSE`, where it drowns
  in the key-exchange transcript it would then have to be trimmed out of. Reading
  the child's own exit is cheaper and does not put debug noise in front of a reader.
- With a warm master the test answers "reachable" without touching the credential,
  and that is the new question. The credential is part of the control socket's name,
  so changing it gets a fresh dial and a real authentication.
- `tsc` clean, `oxlint` 0 warnings and 0 errors, and 107 tests across ten suites are
  green, including the argv split a probe now chooses, the two deadlines no longer
  being one, and the refused background call handing both its slot and its lease
  back. Version 0.0.22 → 0.0.23 under the three-segment rule.

## 0.0.22

### Added

- **Connections are shared per target.** Four remote operations at a time used to
  mean four fresh handshakes and four logins, and four of anything at once locked
  the settings page out of its own Test button. The transport now leases one
  multiplexed OpenSSH connection per target: the call that arrives first dials and
  becomes the master, and the calls that follow ride the same authenticated
  session — no second handshake, no second authentication, and one `sshd` at the
  far end instead of one per call. A master that dies is healed by the next call,
  not by a probe: `ControlMaster=auto` falls back to a direct connection inside
  the child that needed it, so nothing spends a process asking whether the socket
  is alive. (`src/pool.ts`.)
- **A control socket is named by what decides the connection**: the target's id,
  its authority, port, jump host, identity file, extra flags, auth mode, and a
  hash of the secret the call holds. Editing a target therefore cannot inherit the
  master its predecessor left open, and a draft probed with a second typed
  password cannot ride along on a master that authenticated with the first and
  report the wrong secret as good. No secret appears in a file name.
- **A per-target switch.** `pool` (`on` by default) turns sharing off for one
  server, and the reason it exists is the far side: `sshd`'s `MaxSessions` is a
  server setting this plugin does not control, and some hosts are configured
  lower. The page edits it under **Advanced options**; the model reads it as a
  `pool off` chip in the target list. The storage domain is **version 5**, and
  reads 1 through 4: a record with no `pool` means `on`, so no stored file is
  refused or rewritten on upgrade.
- **Two ceilings, for two different costs.** `MAX_CONCURRENT_OPS` counts local
  `ssh` children (what this machine pays for) and `MAX_LIVE_MASTERS` counts
  servers holding a shared connection (what the fleet of servers pays for). A
  ninth server retires the idle master that has been quiet longest with
  `ssh -O exit`; when every master is busy the newcomer dials alone and says so in
  its result rather than opening an unplanned session. Teardown children take no
  operation slot.
- **`ControlPath=none` is the default for any call that leased nothing.** The Host
  account's own `~/.ssh/config` may name a control socket, and a plugin child that
  inherited one would be sharing a master nobody here is counting, on credentials
  nobody chose. `ControlMaster=no` on its own would not prevent that — it still
  joins a listening master. The target's own extra arguments still land last, so a
  reader who writes `-o ControlPath=…` there keeps winning.

### Changed

- **The concurrency limit counts operations, not probes: 4 → 16.** With
  connections shared, the number that mattered stopped being "how many sessions
  may exist" and became "how many local children may exist". The refusal is the
  same shape and still arrives as its own answer instead of a queue.
- The bounds card states the sharing facts beside the existing ones: operations at
  once, servers that may each hold one, and how long an idle shared connection
  stays open (five minutes, `CONTROL_PERSIST_SECONDS`). The limits the page reads
  renamed with them (`concurrentProbes` → `concurrentOps`), and a page loaded
  against a Host that predates the pool keeps its own defaults for the keys the old
  `list` payload never sent while hiding the sharing rows it cannot confirm —
  printing this release's numbers for a process that is not running them is exactly
  the surprise the card exists to prevent. The same in-place-swap tolerance the
  auth modes already had.
- The settings page learns whether the loaded Host has a pool from the `list`
  payload, and only offers the switch and sends the field when it does.

### Notes

- OpenSSH's sharing behaviour was reproduced against a live server rather than
  read out of the manual, and the facts are recorded in `README.md`: a master
  stays up after its first client exits, `-O exit` removes the socket file, and a
  call on a dead path re-authenticates and exits 0. That last fact is what the
  no-probe-on-the-hot-path design rests on.
- A master is a process OpenSSH left in the background, not a child the Host still
  watches. Unloading the plugin closes the masters it knows about and removes the
  private socket directory; a Host killed outright leaves each master on its
  server until the five idle minutes run out. The pool belongs to the Host
  process, so two conversations aimed at one server share one connection.
- Secrets are still needed on every call, pooled or not: when a master turns out to
  be gone, the child that heals it has to authenticate, and it authenticates with
  the credential that call was given.
- The storage bump was read against the file actually on disk, not a fixture: a
  version 4 unit carrying two `password` targets parses under the version 5
  schemas, both defaulting to `pool: on`, and its global slot still reads the same
  three ceilings. Nothing has to be migrated by hand on restart.
- The offline suites grew a tenth file (`pool.test.mjs`: what a socket is named by,
  who is evicted, what gets closed on unload, and the case where every master is
  busy), and the transport suite now pins the sharing flags and the split between a
  multiplexing complaint and a server refusing the call. 104 tests, all green;
  `tsc` clean and `oxlint` reports 0 warnings and 0 errors.

## 0.0.21

### Removed

- **The Probe identity card is gone, and the `runsAs` field feeding it.** The
  Client settings tab now runs from the three ceiling fields straight to the
  bounds card. The card printed `account (uid N) · home`, read live off the Host
  process (`process.getuid()`, `$USER`/`$LOGNAME`, `$HOME`); nothing in the
  plugin acted on any of it, and the named account was the half that decided
  nothing. What a probe actually inherits is that account's whole ssh world —
  `~/.ssh/config`, keys, agent socket, `known_hosts`, and the child's `cwd` —
  so the useful reading was always the path plus what lives there, which the
  card never checked. Its `user` was an environment variable rather than the
  account behind the uid, so launched under a stale environment it printed a
  confidently wrong name. `list` no longer reports `runsAs`; the page's state,
  its two dictionary keys in each language, and the test that pinned the
  payload's shape left with it.

### Notes

- Behaviour is untouched: a probe still runs as the Host account, still records
  an unknown host key on first contact, and still fails on a changed one. The
  detail pages say so directly instead of pointing at a card, and the
  `unknown-host` hint still names the Host account's `known_hosts`.
- Four facts would settle what the card only gestured at: the resolved `ssh`
  path, whether that account's agent holds any identity, whether the named key
  file is readable by it, and whether the host is already in that account's
  `known_hosts`. None is collected today; the shape a revival would take is
  written down in `README.md`.
- No stored record or setting changes: the retired value was never persisted, so
  the storage domain stays at version 4 and old files open as they did.

## 0.0.20

### Added

- **Elevation: `exec` can now run as another account, answered by the stored
  secret.** Two mechanisms, one parameter each:
  - `as: "root"` (or any account name) elevates through **sudo**: the plugin
    prefixes the command, forces a pseudo-terminal, and injects the target's
    **stored login password** into the command's stdin — sudo asks, the plugin
    answers, and the password never appears in the conversation, the transcript,
    or the result. A command the caller already wrote as `sudo …` is kept
    verbatim and only gets the terminal and the answer. When no login password
    is stored, sudo runs with `-n`: a NOPASSWD host answers immediately, a
    prompting one fails fast with `sudo: a password is required` instead of
    waiting out the deadline. An explicit `input` always wins over the stored
    secret.
  - `su: true` reaches root through **su** and her **own password**: a third
    secret slot per target (`ssh/<id>-root` in the credential store, a
    `root 密码（su 提权用）` field in the target form with the same
    typed/cleared/untouched three-state as the other two), injected the same
    invisible way. The command moves whole into `su root -c '…'` so pipelines
    survive the switch. With no stored root password the call is refused with
    a hint pointing at the form, or at `as: "root"` as the other road.
- **A third chip and payload fields:** `get_connection` reports
  `root password stored`, elevated results echo `elevated: <account>` so the
  model can see which identity ran, and the storage slot schema takes `root`
  with the usual tri-state. `as` and `su` together are a `bad-input` refusal.
- **New auth-table fingerprints:** `sudo: a password is required`,
  `… incorrect password …`, and `su: Authentication failure` classify as
  `auth-failed` — with a hint that names the elevation secret, not the ssh
  credential — instead of a bare nonzero exit.

### Notes

- Elevated calls **always ask first**, even when the inner command is on the
  target's allowlist: sudo is a master key, and an allowlist hit on
  `systemctl` never consented to running it as another account. The approval
  prompt names the account and says which secret will be spent (login password
  for sudo, root password for su), in both languages.
- `background: true` with `as`/`su` is refused: a job streams output but has no
  stdin channel to inject a password into. Backgrounded sudo still works if
  the server is NOPASSWD and the command says so itself.
- The password travels to the server as the command's stdin and is subject to
  whatever the session's encryption carries; what the plugin guarantees is
  that it never enters the model's context, argv, or transcript.

## 0.0.19

### Changed

- **The Client settings card is fields only.** The four muted paragraphs — how
  probes use BatchMode and askpass, how ssh and scp are found and what the probe
  deadline is, what the command timeout and the output ceiling mean, what the
  transfer ceiling allows — are gone from the page, both languages, along with
  their dictionary entries. The three inputs and the save button stand alone;
  the fixed facts they used to explain are still on the bounds card beside them,
  and the longer prose lives where readers with time for it go: the plugin's
  detail page.

## 0.0.18

### Changed

- **The Client settings tab went from five fields to three.** The `ssh`
  executable and the probe timeout are no longer settings:
- **The program is detected.** Each call now finds its own `ssh` (then `scp`
  for transfers): bare name on `PATH` first, so the account's preferred install
  wins, then the usual absolute install locations. A hit is cached until the
  plugin reloads; a miss re-runs the search, so installing openssh mid-session
  takes effect without a restart. `scp` prefers the resolved ssh's own sibling
  before falling back to its names. Nothing is still installed or upgraded, and
  a program nobody can find keeps reporting as its own result (`ssh-missing`).
- **The probe deadline is fixed** at ten seconds (`PROBE_TIMEOUT_MS`), which is
  the value every deployment used; the download size pre-check shares it.
- **The storage domain is version 4** and reads 1 through 3. A pre-0.0.18
  global slot's `command` and `probeTimeoutMs` are accepted and ignored, and the
  next settings save drops them; `configUpdate` refuses a request that still
  sends one of the retired fields rather than quietly discarding it. The page
  keeps its three real ceilings - output, command timeout, transfer - and the
  bounds card now states the probe deadline and the detection as fixed facts.

## 0.0.17

### Added

- **The seven consumed fields are now declared.** The tool's `parameters` schema
  carries `oldText`, `newText`, `all`, `replaceFirst`, `backup`, `tty`, and
  `input`, the way the body and the documents have always described them. Until
  now a model met them only through prose; they arrived undeclared and survived
  on the defensive reader alone.
- **The offline suites live in the repository.** `ssh/tests/` carries eight
  `node:test` files and their fake transport/store/secrets helpers, run by
  `pnpm test` (builds first, then `node --test tests/*.test.mjs`): 80 tests over
  the policy gate and every payload's schema agreement, the whole `ops` surface
  at its transport seam including the read marker protocol, the fingerprint
  tables, the zod bounds, the background-job lifecycle, and the two pure
  refusal rules. The CHANGELOG has cited suites since the beginning; none of
  them was ever checked in, so every one of those claims was unverifiable by
  anyone but the author. It is not now.

### Fixed

- **The model-facing wording and the gate now say the same thing about an empty
  allowlist.** `describeRemote` told a model a command "runs freely unless that
  target lists a command allowlist", and `get_connection` rendered
  `allowlist=none(no restriction)`, while `decideAccess` — since it was written —
  asks about every command on a target that lists no programs. The tool text and
  the render line now state the rule the gate runs, and a test asserts the
  description and the verdict agree on the same call.

### Notes

- The suites pinned one real gap found while covering the surface: the tool's
  `maxBytes` reaches `exec` and the transfers, but `read`, `write`, and `edit`
  build their remote call from the stored ceiling only — a per-call
  `maxOutputBytes` handed to `ops` for a file action is ignored by `fileCall`.
  `tests/ops.test.mjs` documents the current behaviour; fixing it is a code
  change for a next iteration.
- The suites also record that a bare `Permission denied, please try again.`
  carries no method tag, so the auth table classifies it `failed` rather than
  `auth-failed`: the retry prompt OpenSSH prints between attempts is not in the
  table's patterns.

## 0.0.16

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
- **The documentation was realigned with the shipped code** (no behavior changed): the
  developer README gained `src/jobs.ts` in its layout map, its route table now names
  `run` (not `exec`) and carries `tty`/`input`, its bounds list carries the background
  deadline and the stdin cap, and its "planned" and "limits" sections moved from the
  0.6.0 story to this release. Both detail pages state the five editable Client settings,
  the background job, and the empty-allowlist rule, and the Chinese page lost a
  duplicated opening sentence and two headings that had no blank line before them. The
  package `description` now names the tool `ssh_client`, which is what it was renamed to
  in 0.12.0.
- Two model-facing strings still describe the allowlist the other way round, verified
  against the compiled `decideAccess`: it asks about **every** command when the
  allowlist is empty (the safe default `storage.ts` documents), while `describeRemote`
  says a command "runs freely unless that target lists a command allowlist" and
  `get_connection` renders `allowlist=none(no restriction)`. Also, the fields `oldText`,
  `newText`, `all`, `replaceFirst`, `backup`, `tty`, and `input` are consumed by the
  body but not declared in the tool's `parameters` schema. Both are follow-up code
  fixes; the docs now state the gate.

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
