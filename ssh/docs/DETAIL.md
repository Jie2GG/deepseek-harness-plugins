# SSH manager

Manages the SSH targets this machine reaches: a named list of hosts and OpenSSH
aliases, how each one logs in, and a connectivity test you can run from the
browser. The conversation can use that server too: the agent gets
one `ssh_client` tool that runs commands (or leaves a long one running in the
background and polls it later), lists and reads files, writes text, replaces
exact text inside a file, and moves files with `scp` — all against the target you
picked for the conversation, with the credentials you stored on this page.
Nothing is installed or upgraded on either side.

## Where the page is

Open **Settings** and pick **Remote connections** in the navigation (中文：设置 →
远程连接). The entry carries its own icon and follows the language you choose in
General settings. Across its top sit two tabs:

- **SSH targets** — the list: add, edit, delete, and test.
- **Client settings** — the output ceiling, the command timeout, and the
  transfer ceiling, next to the bounds the plugin fixes in code (which include
  how it finds `ssh` and `scp` by itself and the fixed 30-second probe deadline).

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
  ceiling a copy may not exceed. Which program dials and how long a connectivity
  test waits are no longer settings at all: `ssh` and `scp` are found by
  themselves (`PATH` first, then the usual install locations), and a probe waits a
  fixed thirty seconds — the download's size pre-check keeps its own ten, because
  one file's metadata should not be given a connectivity test's patience. That tab
  also states the bounds the plugin fixes
  in code, so a value outside a range is not a surprise — three of those lines
  are about sharing: how many remote operations run at once, how many servers
  may each hold one, and how long an idle shared connection stays open.

## Using it from the chat

Just ask. The agent sees the saved aliases — each with where it goes — among the
things it can call, picks the one your conversation is about, and passes it. It can
run a command, list or read a path, write or precisely edit a file, upload or
download, and hand a long-running command to the background to read its output in
pieces or stop it later. Commands can also be run elevated: as another account
through sudo (the plugin answers sudo with that target's stored login password),
or — where sudo is missing — as root through su (answered with a third secret
slot, root's own password, which you save on the target form). Either way the
password is injected into the command behind the scenes: it never appears in the
conversation. Once it
names a server, that conversation keeps using it, so a follow-up like "now the disk
usage" does not repeat the host. Add or remove a target and the choices the agent
sees follow on the next turn, with no conversation restart.

A note on the two switches that are easy to confuse: full workspace permission
governs how freely files may be written, and the approval prompt governs whether
you are asked at all. A conversation set to *never ask* answers every request as a
rejection, decided before anyone can weigh in — so in that kind of conversation the
plugin runs the asking calls rather than refusing them on your behalf. Turning a
target's **agent access** off is still a hard no, and a conversation that does ask
you still gets the confirmation.

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
it; list the programs you trust if those should run unattended. An allowlisted
program is a bare name (`git`, `systemctl`); a pipeline, a redirect, or a
substitution is never treated as one program, so it is always shown to you. A
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

The bundle inserts one plugin row with `config: {}` and this release declares no
configuration fields: everything the page edits lives either in the plugin's own
storage or in the credential store. Any key you add to that row is currently
ignored.

## Limits of this release

- A shared connection is an `ssh` process that OpenSSH left in the background, not
  a child this plugin still watches. Unloading the plugin closes the masters it
  knows about; a Host that is killed outright leaves them alone on the server
  until their five idle minutes run out. And the pool belongs to the Host process,
  not to one conversation: two conversations pointing at the same server ride the
  same connection, which is the point, and also why a server you reach through a
  jump host stays warm for the other one.
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
  `job_output` and stop with `job_kill`; it runs to a deadline of its own (thirty
  minutes or more) and holds one of the plugin's sixteen concurrent remote operations
  until it settles. What is still missing is a terminal you type
  into live, and a command that keeps running on the server after this conversation
  ends — that one wants `nohup` or a systemd unit, which `exec` can set up.
  Elevation (`as`/`su`) is a foreground thing — a backgrounded job has no channel
  to receive the password — but a NOPASSWD server still works in the background
  when the command itself starts with `sudo`.
- After the plugin package is replaced, the running Host keeps its previous module
  until it restarts: before that, the agent has no `ssh` tool and new ceilings
  are not in effect. The settings page follows the browser bundle and updates on its
  own, and it recognises an older Host, hiding the authentication section with an
  explanation instead of rejecting a field that Host does not know.
- The page needs the Host's `/api` carrier, the subprocess provider, the storage
  domain, the credential store, the tool registry, and the mounted filesystem and
  working-directory services; a profile missing any of them keeps the plugin
  inactive rather than failing. `write` and `upload` replace files in place: nothing
  on the server is versioned or rolled back, and a directory download must be asked
  for recursively.
