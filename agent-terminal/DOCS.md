# Agent Terminal

Runs an AI coding-agent CLI directly on your Home Assistant host, in a
persistent terminal you can reach from the sidebar (including on a phone) or
over SSH.

Supported agents:

| `agent` | CLI | Login |
|---|---|---|
| `claude` | Anthropic's [Claude Code](https://github.com/anthropics/claude-code) | Your normal Claude account (subscription) - no API key |

The add-on is built around per-agent adapters, so more can be added - see
[Adding an agent](#adding-an-agent).

## ⚠️ Before you install

This add-on gives an AI coding agent **root inside a container with:**
- read/write access to your Home Assistant config, add-ons, share, backups, and media
- the Supervisor API (`hassio_role: manager` - can restart Core, manage add-ons, etc.)
- optionally, SSH into that container from the network

Only install this if you understand and accept that. Set `authorized_keys`
carefully, keep `ssh_port` off any port-forwarded range, and don't hand this
add-on's SSH access to anyone you wouldn't hand root on your HA box to.

## Setup

1. **Configuration tab**: add your SSH public key(s) to `authorized_keys` (leave
   it empty to disable SSH and use the web panel only).
2. **Start** the add-on.
3. Open the **Agent Terminal** panel in the sidebar (or SSH to `<ha-host>:<ssh_port>`
   as `root`).
4. First run (Claude Code):
   ```
   claude
   /login
   ```
   Choose **"Claude account with subscription"**, open the printed URL on any
   device, approve, copy the code, paste it back. No browser needed on the HA
   host itself. This only has to be done once - the login persists across
   add-on restarts and updates.

## What you get

- **Persistent login** - stored under `/data`, survives restarts/updates.
- **Two ways in** - the sidebar Ingress panel, and SSH (for VS Code Remote-SSH,
  full IDE experience against `/homeassistant`).
- **Shared tmux session** - the panel and SSH attach to the same session, so a
  long-running task keeps going if you close the browser tab or your SSH
  connection drops.
- **Built-in `homeassistant` MCP server** - gives the agent structured tools
  instead of hand-rolled `curl`: `ha_list_entities`, `ha_get_entity_state`,
  `ha_call_service`, `ha_render_template`, `ha_list_services`,
  `ha_get_error_log`. No token to configure - it uses the add-on's own
  Supervisor token.
- **`ha` CLI** on PATH for Supervisor-level operations (`ha core restart`, etc.).

## Options

| Option | Default | Description |
|---|---|---|
| `authorized_keys` | `[]` | SSH public keys allowed to log in. Empty = SSH effectively unusable (no keys accepted). |
| `ssh_port` | `2202` | Port sshd listens on. Also update the add-on's `ports` mapping if you change this. |
| `agent` | `claude` | Which agent CLI to run. Only `claude` exists today. |
| `web_command` | *(agent's CLI)* | Command the sidebar panel / tmux session launches. Leave empty for the agent's own CLI; use `bash -l` for a plain shell. |
| `mobile_ui` | `true` | Serve the touch-friendly terminal page in the sidebar panel. Set `false` to use ttyd’s stock client. |
| `git_user_name` / `git_user_email` | `""` | Optional system-wide git identity for commits made from this add-on. |

## Using it from a phone

The sidebar panel serves a terminal page built for touch, so the add-on is
usable from the Home Assistant companion app:

- **Drag anywhere on the terminal to scroll.** Claude Code (like most TUI agents) asks the terminal for
  mouse tracking and scrolls on wheel events; a touchscreen never produces one,
  which is why long output used to be unreachable. Drags are translated into
  wheel events, so scrolling also works in `less`, in shell scrollback, and in
  anything else running here.
- **A key bar** supplies what mobile keyboards leave out: `Esc`, `Tab`,
  `Shift+Tab`, arrows and page up/down, and - behind the `...` key - `Home`/`End`,
  `Backspace`, `Ctrl+C`, sticky `Ctrl`/`Alt`, text size, and a key that shows or
  hides the on-screen keyboard. Arrows, page up/down and backspace repeat if you
  hold them. Sticky `Ctrl`/`Alt` apply to the next key pressed, including keys
  typed on the real keyboard - so `Ctrl` then `r` sends Ctrl+R.
- **The keyboard no longer shoves the prompt off-screen.** The page sizes itself
  to the visible viewport, so the terminal shrinks to fit above the keyboard
  instead of the whole page scrolling.
- Text size is remembered per device. The key bar is hidden on desktop, where
  the keyboard already has these keys; append `?keys=1` to the panel URL to
  force it on (or `?keys=0` off).

Set `mobile_ui: false` to go back to ttyd's stock client.

## Adding an agent

Everything agent-specific lives in one file, `rootfs/opt/agents/<agent>.sh`.
The rest of the add-on (web terminal, tmux, SSH, MCP server) only talks to
that file through this contract:

| Name | Kind | Purpose |
|---|---|---|
| `AGENT_TITLE` | variable | Display name (panel title, motd). |
| `AGENT_COMMAND` | variable | Command the session runs when `web_command` is empty. |
| `AGENT_DATA` | variable | Directory under `/data` holding the login and settings. |
| `agent_install` | function | Build time: install the CLI into the image. |
| `agent_env` | function | Print `NAME=value` lines the CLI needs (config dir, etc.). |
| `agent_init` | function | Boot time: point the CLI's config at `AGENT_DATA`. |
| `agent_register_mcp NAME CMD [ARGS...]` | function | Register a stdio MCP server in the CLI's own config format. Must be idempotent and must never overwrite a file it can't parse. |
| `agent_login_help` | function | Print first-run login steps for the motd. |

[`claude.sh`](rootfs/opt/agents/claude.sh) is the reference. To add one:

1. Copy it to `rootfs/opt/agents/<agent>.sh` and implement the contract.
2. Add the name to `ARG AGENTS` in the Dockerfile (or pass it via
   `build.yaml` args) so the CLI is installed.
3. Add it to the `agent` schema in `config.yaml`: `list(claude|<agent>)`.

Switching `agent` keeps each agent's data in its own `AGENT_DATA`, so logins
survive switching back and forth.

## Known limitations

- The tmux session (and any in-progress conversation) does **not** survive a
  full add-on restart or update - only the login does. Detach/reattach across
  browser or SSH drops works fine; a container restart is a clean slate.
- The first `http://supervisor/core/api/...` call right after boot can return
  `502` for a few seconds while the proxy warms up - retry.
- Editing `custom_components/*.py` still requires `ha core restart` to take
  effect (Python module caching).
- Tested on amd64/aarch64 HAOS. Not tested on armv7/armv6.

## Support

This is a personal add-on, shared as-is with no support commitment. Read the
source before you install it - it's short enough to actually read.
