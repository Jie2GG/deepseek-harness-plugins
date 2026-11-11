# GitHub CLI

Adds a **GitHub** page to the Harness settings panel for the GitHub CLI (`gh`)
installed on the machine this Host runs on. Two cards, one for the accounts `gh`
holds and one for the executable itself.

Open it from the sidebar foot: **Settings → GitHub CLI**.

## Accounts

- Lists every host and account `gh` knows, with the active one marked, plus its
  scopes, how its credential is stored, and the git protocol recorded for it.
- **Sign in with the browser** starts `gh auth login --web` and shows the
  one-time code and its URL as soon as `gh` prints them, so you can finish the
  flow on any device. The card keeps polling until the sign-in succeeds, fails,
  or you cancel it.
- **Sign in with a token** feeds a pasted personal access token to
  `gh auth login --with-token`. The token is never displayed and never stored by
  the plugin; `gh` keeps it in its own credential store.
- **Make active** switches the active account when a host holds more than one,
  and **Log out** drops one account's credentials after an inline confirmation.
- **Copy token** asks the Host for the active token of that account and puts it
  on your clipboard; nothing else on the page ever reveals it.

## Installation

- Reports the `gh` executable this plugin resolves, its version, and whether the
  path came from the plugin's own configuration or from `PATH`.
- **Check for updates** reads the newest `cli/cli` release from api.github.com
  (with your `gh` token when one is available, so the rate limit is not a
  problem) and compares it with the active version.
- **Install latest release** downloads the official Linux tarball for this
  machine's architecture, verifies its sha256 against the release's
  `checksums.txt`, unpacks it with `tar`, and places the result in
  `~/.local/share/dsh-plugin-github/bin/gh` (honouring `XDG_DATA_HOME`). It then
  points this plugin at that copy and confirms the new binary runs.
- **Delete managed copy** removes only that plugin-owned file.
- The **gh executable** field writes this plugin's own configuration through the
  profile patch layer, which restarts the plugin. **Use gh from PATH** clears it.

## Configuration

The bundle row is `id: github`. Its configuration is editable in your profile
patch, and the page changes `command` for you:

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | `gh` | Executable name or absolute path every `gh` call uses. |
| `timeoutMs` | 30000 (1000–300000) | Deadline for one `gh` call. |
| `maxOutputBytes` | 65536 (1024–4194304) | Captured bytes per `gh` output stream. |

## Boundaries

- This plugin never calls apt, dnf, or Homebrew. On macOS and Windows, and on
  Linux architectures without an official tarball, it says so and leaves the
  install to your package manager.
- It does not run `gh` commands on your behalf beyond the account and status
  calls listed above, and it registers no agent tool yet.
- `gh auth refresh` and other prompts that need a terminal are not offered;
  interactive prompts are disabled so a stuck prompt fails loudly instead.
- Children this plugin starts inherit a scrubbed environment, so `GH_TOKEN` and
  `GITHUB_TOKEN` do not reach `gh` unless the plugin forwards them; the keyring
  or config-file credential `gh` already uses keeps working.
- Every action runs on the Host and is reachable only from the page that this
  same Host serves.
