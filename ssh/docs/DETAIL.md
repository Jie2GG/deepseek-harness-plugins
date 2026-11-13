# SSH manager

Manages the SSH targets this machine reaches: a named list of hosts and OpenSSH
aliases, how each one logs in, and a connectivity test you can run from the
browser. From **0.6.0** the conversation can use that server too: the agent gets
one `remote` tool that runs commands, lists and reads files, writes text, and moves
files with `scp` — all against the target you picked for the conversation, with the
credentials you stored on this page. Nothing is installed or upgraded on either
side.

## Where the page is

Open **Settings** and pick **Remote connections** in the navigation (中文：设置 →
远程连接). The entry carries its own icon and follows the language you choose in
General settings. Across its top sit two tabs:

- **SSH targets** — the list: add, edit, delete, and test.
- **Client settings** — the `ssh` executable, the probe timeout, and the output
  ceiling every probe honours, next to the bounds the plugin fixes in code.

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
  **Key + password** choice 0.4.0 offered is gone from the picker: a saved target
  that still carries it keeps its label and still probes exactly as before, it can
  only no longer be selected or written anew.
- **Connectivity test.** `Test` runs one probe per target; `Test all` covers the
  first 12 in one round. A probe connects with the same options and secrets the
  target will use and runs only `true` on the far side: a key target keeps
  `BatchMode=yes` and never waits, while a secret-backed target answers its prompt
  through the plugin's own askpass helper and is allowed exactly one prompt.
  Results are classified as reachable, authentication failed, unreachable, host
  key not trusted, timed out, or `ssh` not found, and the last result is kept
  with its timestamp and the captured output tail.
- **Client settings**, on the second tab: the `ssh` executable (a name on
  `PATH` or an absolute path), the probe timeout, and the captured output
  ceiling. That tab also states the bounds the plugin fixes in code, so a value
  outside a range is not a surprise.

## Using it from the chat

Open a conversation and choose the server in the composer's session menu (the row
labelled **Remote server**, next to the model and reasoning controls). From then on
the agent can call `remote` without naming a host: it lists what is saved, runs a
command, lists or reads a remote path, writes a file, and uploads or downloads one.

What runs without interrupting you:

| The call | What happens |
| --- | --- |
| list, read, download, or show the saved targets | runs immediately |
| a command whose program is in that target's **command allowlist** | runs immediately |
| any other command, and any write or upload | asks you first, in your language, showing the server and the exact command or path |
| anything against a target with **agent access** turned off | refused |

An allowlisted program is a bare name (`git`, `systemctl`); a pipeline, a redirect,
or a substitution is never treated as one program, so it is always shown to you. A
profile without an approval surface refuses the asking calls rather than running
them unattended.

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
- Deleting a target forgets both of its secrets.
- A password typed into an unsaved form is used once, by **Test before saving**,
  and is stored only if you save.
- `ssh` reads the secret through the plugin's askpass helper instead of a terminal
  or a command line, so it never appears in the process list. A private key is
  still referenced by path only.

Two honest limits: the store is readable by your own OS user, and agent tool
processes run as that same user, so a stored secret is private from other users
rather than hidden from the agent. And a stored secret still only ever runs `true`
on the remote machine — the plugin executes nothing else there yet.

## When your terminal connects but the page does not

A probe is not your terminal session. It runs as the account the Harness Host
process uses, and the Client settings tab names that account under **Probe
identity**. That account has its own `~/.ssh/config`, its own private keys, its
own `ssh-agent`, and its own `known_hosts`, so:

- an alias that works in your terminal may resolve to something else, or nothing,
  for the Host account;
- a key you reach through `ssh-agent` in your shell is not in that agent;
- a host you accepted interactively once is not automatically trusted there —
  the first probe records it instead of asking.

The stored password path does not depend on any of that: it authenticates by
itself, which is why 0.5.1 made an unknown host key a recorded fact rather than
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

## Planned behaviour

1. An interactive or long-running remote session (a PTY, or a background job the
   conversation can poll), so commands that need input or outlive one reply fit.
2. Showing the settings `ssh -G` resolves for a target, so an alias can be checked
   against what the OpenSSH client would really use.
3. Reading the aliases in `~/.ssh/config` as a suggested inventory.

None of these exist yet, and the interface may still change.

## Configuration

The bundle inserts one plugin row with `config: {}` and this release declares no
configuration fields: everything the page edits lives either in the plugin's own
storage or in the credential store. Any key you add to that row is currently
ignored.

## Limits of this release

- The page and its two tabs are the only surface; the agent cannot see or use
  this list yet.
- A probe authenticates but executes nothing beyond `true`; running a real remote
  command with these secrets is the next step.
- After the plugin package is replaced in place, the running Host keeps its old
  module until it restarts. The page notices that and hides the authentication
  choice with an explanation, rather than rejecting a field the old Host does not
  know.
- The page needs the Host's `/api` carrier, the subprocess provider, the
  storage-domain facility, and the credential store; in a profile missing any of
  them the plugin stays inactive instead of failing.
- No Web UI beyond the settings page.
