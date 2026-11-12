# SSH manager

A plugin that will manage SSH from the machine this Harness Host runs on: which
hosts the local OpenSSH client can reach, which aliases and identity files are
configured, whether a host actually answers, and which remote commands the agent
is allowed to run.

## What version 0.1.0 does

Nothing visible. The plugin is a scaffold: it activates, registers no agent tool,
starts no process, reads no SSH configuration, and opens no panel. Enabling or
disabling it changes no behaviour in the app, so it is safe to keep installed
while the capability is being built.

This round fixes the package layout only — the bundle manifest, the patch entry,
the display metadata, the icon, and the detail documents.

## Planned behaviour

Later versions are expected to add, in this order:

1. A read-only host inventory: the aliases in the OpenSSH client configuration,
   the settings `ssh -G <host>` resolves for each of them (user, port, identity
   file, proxy jump), and the state of `~/.ssh/known_hosts`.
2. A connectivity probe: `ssh -o BatchMode=yes <host> true` under a timeout, so
   an authentication failure is reported separately from a network failure.
3. A `run` action that executes one command on one host under allowlists for
   hosts and commands, with output and time limits.
4. Plugin configuration for the `ssh` executable name, the configuration files to
   read, probe and run timeouts, the captured output size, and the host and
   command allowlists. A key passphrase stays in the Harness credential store,
   never in configuration.
5. Possibly a panel in the Web UI for the same operations.

None of these exist yet, and the interface may still change.

## Relation to the Harness SSH runtime

DeepSeek Harness also ships an SSH *deployment*: `@deepseek-ai/dsh-ssh` together
with its filesystem, subprocess and sandbox providers makes the machine behind
`ctx.fs` and `ctx.subprocess` a remote one. That is a different axis from this
plugin, which keeps the Harness where it is and talks to *other* hosts through
the local OpenSSH client. The two share no configuration.

## Configuration

The bundle inserts one plugin row with an empty `config: {}`. Version 0.1.0
declares no configuration fields, so every key you add there is currently
ignored.

## Limits of this release

- The plugin never reads or writes `~/.ssh/config`, keys, or agent sockets.
- It stores no secrets and opens no connections.
- No Web UI contribution is registered.
