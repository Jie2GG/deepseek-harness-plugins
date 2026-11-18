# SSH manager

Manages the SSH targets this machine reaches: a named list of hosts and OpenSSH
aliases, how each one logs in, and a connectivity test you can run from the
browser. The conversation can use that server too: the agent gets
one `ssh_client` tool that runs commands (or leaves a long one running in the
background and polls it later), lists and reads files, writes text, replaces
exact text inside a file, and moves files over `ssh` — all against the target you
picked for the conversation, with the credentials you stored on this page.
Nothing is installed or upgraded on either side.

## Where the page is

Open **Settings** and pick **Remote connections** in the navigation (中文：设置 →
远程连接). The entry carries its own icon and follows the language you choose in
General settings. Across its top sit two tabs:

- **SSH targets** — the list: add, edit, delete, and test.
- **Client settings** — the output ceiling, the command timeout, and the
  transfer ceiling, each stated as this profile's override of a configured default
  and cap, next to the bounds this Host resolves them against.

Both tabs read and write one page state, so a probe you started on the first tab
keeps running while you edit values on the second.

## What the current version does

- **SSH target list.** Add, edit, and delete named targets. One field takes the
  address — `[user@]host[:port]`, an `ssh://` form, an IPv6 literal in brackets,
  or a bare name read as an OpenSSH host alias — while a collapsed **Advanced
  options** section holds the jump host, extra `ssh` arguments (one `ssh` argv
  entry per line), and a note. The display name is optional and falls back to the
  address. The list holds up to 64 targets.
- **Resolve, per target.** A **Resolve** button asks the local OpenSSH client what
  the address really means — the host, port, user, identity files, jump host, or
  `ProxyCommand` it would dial — without contacting the server. When that answer
  differs from what you saved, a chip says so, because that is the usual reason an
  alias works in your terminal and not here: the resolution runs as the same
  account that runs the probes.
- **Two ways to log in.** Pick **Key** (ssh-agent or a private key, with an
  optional passphrase when the key is encrypted) or **Password** (publickey offers
  are skipped). The choice is remembered per target and shown on its row. The
  **Key + password** choice an earlier release offered is gone from the picker: a saved target
  that still carries it keeps its label and still probes exactly as before, it can
  only no longer be selected or written anew.
- **Connectivity test.** `Test` runs one probe per target; `Test all` covers the
  first 12 in one round. A probe connects with the same options and secrets the
  target will use and asks the question the button is really answering: can this
  credential get an authenticated session open. A target riding a shared
  connection stops at login — `-N`, measured at two tenths of a second for a first
  connection and a tenth for a warm one — while a target dialing its own still
  runs `true` on the far side, because with no master to leave behind `-N` would
  sit idle until its deadline. A key target keeps `BatchMode=yes` and never waits,
  while a secret-backed target answers its prompt through the plugin's own askpass
  helper and is allowed exactly one prompt. A probe waits a fixed thirty seconds,
  of which the connect phase takes a third (capped at ten seconds), so a host
  nobody answers still fails fast. Results are classified as reachable,
  authentication failed, unreachable, host key not trusted, timed out, or `ssh`
  not found, and the last result is kept with its timestamp and the captured
  output tail.
- **Connections are shared.** On one server, the connection the first command
  opened stays in the plugin's hands, and the calls that follow ride on it — no
  fresh handshake, no fresh login per command, and one `sshd` working for you at
  the far end instead of one per call. Eight servers may hold a connection at a
  time, and each one drops after five idle minutes. Some servers behave
  differently once several commands share a connection, and for those the
  collapsed **Advanced options** of that target carries a **Share this server's
  connection** switch.
- **Client settings**, on the second tab: the captured output ceiling, the
  command timeout every agent-issued remote call obeys, and the file-transfer
  ceiling a copy may not exceed. Those three fields are now this profile's
  **overrides**: empty follows the configured default, and any positive number is
  accepted — one past the cap is capped, and the value that actually applied is
  echoed back instead of the number being refused. Which program dials is still
  not a setting (`ssh` and `scp` find themselves, `PATH` first and then the usual
  install locations). The card beside them is no longer **Fixed bounds** but
  **Resolved bounds**: each ceiling reads “in force / default / cap”, so the
  number a call actually ran against is visible rather than inferred, and the
  remaining lines are this Host's fixed rules — how many remote operations run at
  once, how many servers may each hold one shared connection, how long an idle
  connection stays open, how many targets one **Test all** round covers, and how
  long a probe waits (thirty seconds, with the copy's size and tree-counting
  questions keeping their own ten and the copy itself keeping its own five minutes), and how many copies
  and jobs may hold a slot at once. The ceilings the page and a call can move —
  command deadline, output capture, transfer size and transfer deadline — are
  resolved from the same defaults-and-caps table above, and a number that comes
  down to a cap is echoed back as what actually ran.

## Using it from the chat

Just ask. The agent sees the saved aliases — each with where it goes — among the
things it can call, picks the one your conversation is about, and passes it. It can
run a command, list or read a path, write or precisely edit a file, upload or
download, and hand a long-running command to the background to read its output in
pieces or stop it later. Commands can also be run elevated: as another account
through sudo (the plugin answers sudo with that target's stored login password),
or — where sudo is missing — as root through su (answered with a third secret
slot, root's own password, which you save on the target form). A target that
names a private key gets `-o IdentitiesOnly=yes` alongside it, so an agent full
of other keys cannot burn the server's authentication attempts before the named
key is tried; name no key and the client's own defaults stand. Either way the
password is injected into the command behind the scenes: it never appears in the
conversation. The prompt and an `input` body speak the same one stdin, and the
prompt reads first, so elevation and input refuse each other up front — `su`
always, and `as` whenever a login password is stored; the `sudo -n` shape (no
stored password) is the one combination where the body arrives intact. Once it
names a server, that conversation keeps using it, so a follow-up like "now the disk
usage" does not repeat the host. Add or remove a target and the choices the agent
sees follow on the next turn, with no conversation restart.

A note on the two switches that are easy to confuse: full workspace permission
governs how freely files may be written, and the approval prompt governs whether
you are asked at all. A conversation set to *never ask* answers every request as a
rejection, decided before anyone can weigh in — so in that kind of conversation the
plugin runs the asking calls rather than refusing them on your behalf. Turning a
target's **agent access** off is still a hard no, and a conversation that does ask
you still gets the confirmation. The opposite case — a profile with no approval
service mounted at all, or a call with no conversation to route a question
through — is *not* treated as that standing decision: the ask goes to the core,
and the core refuses it with a reason naming what is missing. Full-access mode is
consent somebody stated; an unreachable approver is nobody saying yes.

What runs without interrupting you:

| The call | What happens |
| --- | --- |
| list a directory, read a file, download, or ask which server this is (`get_connection`) | runs immediately |
| a command run elevated (sudo as another account, or su to root) | always asks you first, even when the command itself is allowlisted — the prompt names the account and says which stored password it will spend |
| a single-program command whose one bare program is on that target's **command allowlist** | runs immediately |
| an edit of a remote file (exact text, refused when it matches more than once) | asks you first |
| a command left running in the background (`background: true`) | the same verdict as the same command run in the foreground |
| any other command, and any write or upload | asks you first, in your language, showing the server and the exact command or path |
| anything against a target with **agent access** turned off | refused |

A fresh target has an **empty allowlist**, and that asks about every command on
it; both switches — agent access and the no-approval list — are edited on the
target form, and the row shows an `agent access off` chip and a count chip for a
non-empty list. The list is a no-approval list, not a sandbox and not a limit:
listing `git` lets a bare `git …` run without asking, and constrains nothing
else about it. An allowlisted program is a bare name (`git`, `systemctl`); a
pipeline, a redirect, or a substitution is never treated as one program, so it
is always shown to you. A
conversation that will not ask at all — its approval policy is *never ask* — runs
those calls instead of refusing them, because in that conversation an ask is settled
as a rejection before anyone can weigh in; turning a target's **agent access** off is
still the hard no.

Local files live inside that conversation's workspace: a transfer path outside it,
including one that walks up with `..`, is refused before anything moves.

## Where your data is kept

The plugin owns its data: targets and settings are stored in its own storage
domain, `ssh_targets`, which the Host writes as
`$DSH_HOME/storages/ssh_targets.json` on the default backend. The profile's
`cordis.patch.yml` keeps only the plugin row this bundle inserts, so saving from
the page never rewrites your patch file and never restarts the plugin.

Two consequences worth knowing:

- Deleting the plugin leaves that JSON file in place until you remove it.
- Backing up `$DSH_HOME/storages/` covers this plugin's data; the patch file
  alone does not.
- The list also remembers which target each conversation picked, in the same file;
  delete a target and those choices go away with it.

## Passwords and passphrases

A secret a target logs in with is kept in the Harness credential store — the
private file `$DSH_HOME/.credentials.yaml`, mode readable by your owner only —
addressed `ssh/<target>-password` and `ssh/<target>-passphrase`. It never enters
this plugin's own JSON, never enters the profile patch file, and never travels
back to the browser:

- Leaving a secret field empty means “keep what is stored”; ticking **Forget the
  stored value** removes it.
- The list states only whether a slot is filled, never its contents.
- A third slot, **root's own password**, is used only when the agent asks for a
  command through `su`; sudo uses the login password instead. All of them follow
  the same rules above.
- Deleting a target forgets all three of its secrets.
- A password typed into an unsaved form is used once, by **Test before saving**,
  and is stored only if you save.
- `ssh` reads the secret through the plugin's askpass helper instead of a terminal
  or a command line, so it never appears in the process list. A private key is
  still referenced by path only. When a command is elevated, the password rides
  the encrypted channel as that command's own standard input — outside the
  conversation, the transcript, and the process table alike.

Two honest limits: the store is readable by your own OS user, and agent tool
processes run as that same user, so a stored secret is private from other users
rather than hidden from the agent. And the page's own test stops at login (only a
target with sharing switched off runs one `true` on the server): every wider use
of those credentials — commands, edits, transfers — goes through the chat tool,
under the approval rules above.

## When your terminal connects but the page does not

A probe is not your terminal session. It runs as the account the Harness Host
process uses — the account that launched Harness, which need not be the one you
type `ssh` in — and that account has its own `~/.ssh/config`, its own private
keys, its own `ssh-agent`, and its own `known_hosts`, so:

- an alias that works in your terminal may resolve to something else, or nothing,
  for the Host account;
- a key you reach through `ssh-agent` in your shell is not in that agent;
- a host you accepted interactively once is not automatically trusted there —
  the first probe records it instead of asking.

The stored password path does not depend on any of that: it authenticates by
itself, which is why an earlier release made an unknown host key a recorded fact rather than
an unanswerable question.

## What the page never touches

- `~/.ssh/config`, your keys, and your agent sockets are read by `ssh` itself,
  never written by this plugin.
- `known_hosts`, apart from one thing: an unknown host key is **recorded on
  first contact** (`StrictHostKeyChecking=accept-new`), because the probe has no
  terminal to ask on and would otherwise wait forever. A host key that has
  **changed** is still refused, never overwritten.
- The `ssh` binary: nothing is installed or upgraded; a missing executable is
  reported as its own result.
- The control sockets sharing lives on: they are not in `~/.ssh` and never in
  `$DSH_HOME`. They sit in a private temporary directory the plugin opens at
  activation (owner-only permissions), and the directory and everything in it go
  away when the plugin unloads, so a socket is neither something to back up nor
  something that outlives the process.

## Planned behaviour

1. A terminal you can type into live: a command can already be given a
   pseudo-terminal (`tty`), an answer to a prompt (`input`), or a background job
   the conversation polls and can stop — but there is no interactive session.
2. Reading the aliases in `~/.ssh/config` as a suggested inventory.

Neither exists yet, and the interface may still change. What used to head this
list — the pollable background job and the `ssh -G` resolve view — have both shipped.

## Configuration

The plugin row the bundle inserts now **reads** its `config:` keys. Every tunable
is a default-and-cap pair, and every one is live — a profile edit reaches the next
call rather than the next restart:

| Key | Default | Cap | What it governs |
| --- | --- | --- | --- |
| `timeoutMs` / `maxTimeoutMs` | 30 s | 300 s | One foreground remote command, and the most any layer (page, target, one call) may ask for |
| `outputBytes` / `maxOutputBytes` | 64 KiB | 4 MiB | Per-stream in-memory capture — stdout and stderr each get their own |
| `transferBytes` / `maxTransferBytes` | 32 MiB | 512 MiB | One file — the ceiling enforced while its bytes move; for a tree, what the server said before they did |
| `transferTimeoutMs` / `maxTransferTimeoutMs` | 5 min | 30 min | The whole budget of one copy, on its own clock: a transfer never borrows the command's 30 s, and a call's `timeoutMs` on the transfer actions reads as "how long to wait for the copy" |
| `maxTransferFiles` | 500 | — | Pre-check cap on how many files one recursive upload may carry, counted at walk time |
| `maxTransferTotalBytes` | 512 MiB | — | Pre-check cap on the cumulative bytes of one recursive upload, also at walk time |
| `maxConcurrentTransfers` | 2 | 16 | How many copies may hold one of the 16 operation slots at once, so transfers cannot starve commands |
| `maxRunningJobs` | 8 | 16 | How many explicitly backgrounded jobs may hold a slot at once; the rest stay reserved for foreground calls |
| `probeTimeoutMs` | 30 s | — | How long a connectivity test waits; the page has no field for it |
| `statTimeoutMs` | 10 s | — | The size, type, and tree-counting questions a copy asks before moving bytes |
| `maxSpillBytes` | 64 MiB | — | How large a spill file may grow; `0` writes none, and the result says there is no file to look for |
| `promoteOnTimeout` | on | — | Hand a command that runs out of time to the job registry instead of killing it |
| `graceMs` | 2 s | — | SIGTERM to SIGKILL grace for a child |

Two things follow from that, and both are worth knowing before you reach for the
page. The three fields on it are now this profile's **overrides**: empty means
“follow the configured default”, and any positive number is accepted — one past
the cap is **capped and echoed back**, where the old build rejected it outright.
And raising `maxTimeoutMs` above 300 s needs a Host restart before the plugin's
*declared tool-call budget* follows it; until then the harness answers a call that
outlives the old budget with its own `tool call timed out`, not with this plugin's
classified result.

## Limits of this release

- A shared connection is an `ssh` process that OpenSSH left in the background, not
  a child this plugin still watches. Unloading the plugin closes the masters it
  knows about; a Host that is killed outright leaves them alone on the server
  until their five idle minutes run out. And the pool belongs to the Host process,
  not to one conversation: two conversations pointing at the same server ride the
  same connection, which is the point, and also why a server you reach through a
  jump host stays warm for the other one.
- Over-cap output is no longer a tail and a shrug. The complete stdout and stderr of
  a call are written by the subprocess provider into its own private temporary
  directory, and the result names the file
  (`[output truncated; full output — stdout: /tmp/dsh-subprocess-…/….log]`). Two
  exceptions are stated rather than hidden: a profile with `maxSpillBytes: 0`
  configures no file at all and the result says so, and a stream larger than
  `maxSpillBytes` has its spill abandoned and keeps only the in-memory tail. Those
  files live in the system temp directory, not in this conversation's workspace.
- A downloaded file is listed among the conversation's changes, the same way an edited
  workspace file is, because the plugin asks the file pipeline for permission before the
  copy starts. Two honest caveats: only the first change to a path within a turn keeps a
  before-image, and a sub-agent's conversation is not tracked by the recorder.
- The settings page and its two tabs are the only **interface**; the conversation
  reaches the same capability through the `ssh_client` tool, whose call renders in the
  harness's own tool row like any other tool's.
- A page probe authenticates and stops there: it runs no command of yours, so it
  cannot say whether the remote shell itself is broken (only a target with sharing
  switched off gets one `true`), and while a shared connection is warm the answer
  is "reachable" without touching the credential — the question is now "does this
  credential have an authenticated session". Change the credential and the control
  socket is named differently, so the next probe re-authenticates for real. Real
  commands come from the agent's `exec` action, and nothing on the server is
  installed or upgraded by this plugin.
- A foreground remote call is waited for: there is no terminal to type into live.
  A command that needs a terminal can be given one
  (`tty: true`) and handed its answer (`input: "…"`). A command that will outlive one
  reply can be left running with `background: true`, which returns a job id to poll with
  `job_output` and stop with `job_kill`. Such a job has **no deadline of its own**:
  it lives until it settles, until `job_kill`, until its conversation goes away, or
  until the Host exits — holding one of the plugin's sixteen concurrent operation
  slots the whole while. And a foreground call that runs out of time is no longer
  killed: by default it is **handed to the job registry** mid-flight, answering
  `status=promoted` with the job id and whatever the command had already produced
  (that preview is not "truncated" — the stream is still being written, and
  `job_output` reads it from the beginning); an elevated call can be handed over too
  — its password was injected at spawn,
  not at the deadline). If that conversation already holds every background slot,
  the hand-over is refused and the plugin falls back to killing, saying which of the
  two happened. What is still missing is a terminal you type
  into live, and a command that keeps running on the server after this conversation
  ends — that one wants `nohup` or a systemd unit, which `exec` can set up.
  Elevation (`as`/`su`) still can't be **started** in the background — a command
  launched that way has no channel to receive its password — but a NOPASSWD server
  works in the background when the command itself starts with `sudo`.
- After the plugin package is replaced, the running Host keeps its previous module
  until it restarts: before that, the agent has no `ssh` tool and new ceilings
  are not in effect. The settings page follows the browser bundle and updates on its
  own, and it recognises an older Host, hiding the authentication section with an
  explanation instead of rejecting a field that Host does not know.
- The page needs the Host's `/api` carrier, the subprocess provider, the storage
  domain, the credential store, the tool registry, and the mounted filesystem and
  working-directory services; a profile missing any of them keeps the plugin
  inactive rather than failing. A **single file** copy is held to its size ceiling
  while the bytes move — the count is taken at this end, and a file that grows
  mid-copy is stopped, with the answer quoting how much arrived rather than how
  much a `stat` once said. A **tree** rides `scp -r` for its layout and symlink
  behaviour, and is measured before it moves: the local walk for an upload, one
  enumeration on the server for a download, and the result says which kind of
  ceiling answered (`limitMode`). Both directions land where they belong: a
  download in a temporary sibling renamed in only on a clean finish, an upload in
  a sibling on the server that then takes its final name *through* an existing
  file — keeping its inode, mode, owner and hardlinks — or by rename with the
  source's permission bits for a fresh one. A refused upload removes its temp; a
  recursive download refuses to land on a local directory that is not empty
  rather than copying the tree and then failing.
  An `edit` reads the file **and its version and its digest** in one trip, copies
  it before truncating, writes through the same inode, checks the size it had to
  leave **and the SHA-256 of the bytes it sent**, and if any of that goes wrong a
  repair child puts the previous content back — then says which outcome happened and
  on what evidence: `verdict` carried by a `digest`, or by a byte count alone, which
  is reported as `unknown` and never as a success. The digest guard is what catches
  the case a size check cannot see — another writer landing a body of the same length
  and different bytes. The
  window between noticing a change and making one is now two shell builtins wide
  rather than a network trip, but it is a window: this is a preview-and-confirm
  flow, not a transaction. `dryRun: true` previews the match count and the diff
  without writing or backing anything up, and warns when the server cannot state a
  version for the write to be checked against.
