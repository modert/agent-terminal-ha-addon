# Claude Code

Runs Anthropic's [Claude Code](https://github.com/anthropics/claude-code) CLI
directly on your Home Assistant host, authenticated with your normal Claude
account (subscription) - no API key.

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
3. Open the **Claude Code** panel in the sidebar (or SSH to `<ha-host>:<ssh_port>`
   as `root`).
4. First run:
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
- **Built-in `homeassistant` MCP server** - gives Claude structured tools
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
| `web_command` | `claude` | Command the sidebar panel / tmux session launches. Use `bash -l` for a plain shell. |
| `git_user_name` / `git_user_email` | `""` | Optional system-wide git identity for commits made from this add-on. |

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
