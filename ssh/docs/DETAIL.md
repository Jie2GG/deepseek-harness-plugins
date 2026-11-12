# SSH manager

Manages the SSH targets this machine reaches: a named list of hosts and OpenSSH
aliases, the settings each one connects with, and a connectivity test you can
run from the browser. Version **0.3.0** keeps the same operations and splits them
into two tabs inside one settings page; the agent still runs nothing on your
behalf.

## Where the page is

Open **Settings** and pick **Remote connections** in the navigation (中文：设置 →
远程连接). The entry carries its own icon and follows the language you choose in
General settings. Across its top sit two tabs:

- **SSH targets** — the list: add, edit, delete, and test.
- **Client settings** — the `ssh` executable, the probe timeout, and the output
  ceiling every probe honours, next to the bounds the plugin fixes in code.

Both tabs read and write one page state, so a probe you started on the first tab
keeps running while you edit values on the second.

## What version 0.3.0 does

- **SSH target list.** Add, edit, and delete named targets. Each one carries a
  display name, a host name or an existing OpenSSH host alias, and optionally a
  remote user, a port, an identity file, a jump host, extra `ssh` arguments (one
  argv entry per line), and a note. The list holds up to 64 targets.
- **Connectivity test.** `Test` runs one probe per target; `Test all` covers the
  first 12 in one round. A probe is
  `ssh -o BatchMode=yes -o ConnectTimeout=<n> … <host> true`, so it never waits
  for a passphrase and never runs a command on the remote machine beyond `true`.
  Results are classified as reachable, authentication failed, unreachable, host
  key not trusted, timed out, or `ssh` not found, and the last result is kept
  with its timestamp and the captured output tail.
- **Client settings**, on the second tab: the `ssh` executable (a name on
  `PATH` or an absolute path), the probe timeout, and the captured output
  ceiling. That tab also states the bounds the plugin fixes in code, so a value
  outside a range is not a surprise.

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

No secret is stored or displayed. A private key is referenced by path only.

## What the page never touches

- `~/.ssh/config`, your keys, and your agent sockets are read by `ssh` itself,
  never written by this plugin.
- `known_hosts`: the probe keeps OpenSSH's strict host-key checking, so an
  untrusted host is reported instead of silently accepted. Connect once from a
  terminal to record the key.
- The `ssh` binary: nothing is installed or upgraded; a missing executable is
  reported as its own result.

## Planned behaviour

1. An agent tool over the same operations, so a model can ask whether a target
   answers and run bounded commands on it.
2. Remote command execution under host and command allowlists.
3. A passphrase stored in the Harness credential store, never in a file.
4. Reading the aliases in `~/.ssh/config` as a suggested inventory.

None of these exist yet, and the interface may still change.

## Configuration

The bundle inserts one plugin row with `config: {}` and 0.3.0 declares no
configuration fields: everything the pages edit lives in the plugin's own
storage. Any key you add to that row is currently ignored.

## Limits of this release

- The page and its two tabs are the only surface; the agent cannot see or use
  this list yet.
- A probe can authenticate only with what a non-interactive `ssh` can use today:
  an agent, or a key without a passphrase.
- The page needs the Host's `/api` carrier, the subprocess provider, and the
  storage-domain facility; in a profile without any of them the plugin stays
  inactive instead of failing.
- No Web UI beyond the settings page.
