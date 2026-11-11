# GitHub CLI

A plugin that will manage the GitHub CLI (`gh`) installed on the machine this
Harness Host runs on: where it is, which version it is, whether it is signed in,
which extensions it carries, and which `gh` commands the agent may run.

## What version 0.1.0 does

Nothing visible. The plugin is a scaffold: it activates, registers no agent tool,
starts no process, and opens no panel. Enabling or disabling it changes no
behaviour in the app, so it is safe to keep installed while the capability is
being built.

This round fixes the package layout only — the bundle manifest, the patch entry,
the display metadata, the icon, and the detail documents.

## Planned behaviour

Later versions are expected to add, in this order:

1. A read-only status action: resolved executable path, `gh --version`,
   `gh auth status`, `gh extension list`, `gh config list`.
2. A `run` action that executes `gh <subcommand> …` under a configurable
   subcommand allowlist and output and time limits.
3. Plugin configuration for the executable name, the allowlist, the timeout, the
   captured output size, and whether commands run in the session's working
   directory.
4. Possibly a panel in the Web UI for the same operations.

None of these exist yet, and the interface may still change.

## Configuration

The bundle inserts one plugin row with an empty `config: {}`. Version 0.1.0
declares no configuration fields, so every key you add there is currently
ignored.

## Limits of this release

- The plugin never reads, writes, installs, or upgrades `gh` itself.
- GitHub credentials stay wherever `gh` keeps them; the plugin stores no secrets.
- No Web UI contribution is registered.
