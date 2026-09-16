# Agent Terminal

Runs an AI coding-agent CLI directly on your Home Assistant host, in a
persistent terminal you can reach from the sidebar (including on a phone) or
over SSH.

Supported agents:

| `agent` | CLI | Login |
|---|---|---|
| `claude` | Anthropic's [Claude Code](https://github.com/anthropics/claude-code) | Your normal Claude account (subscription) - no API key |
| `codex` | [OpenAI Codex](https://developers.openai.com/codex/cli/) (ChatGPT) | ChatGPT account with Codex access, using device code sign-in; API key also supported |

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

1. **Configuration tab**: choose the initial agent, `agent: claude` or `agent: codex`. Add your SSH
   public key(s) to `authorized_keys` if you want SSH access, or leave it empty
   to use the web panel only. Leave `web_command` empty to launch the selected
   agent.
2. **Start** the add-on.
3. Open the **Agent Terminal** panel in the sidebar (or SSH to `<ha-host>:<ssh_port>`
   as `root`).
4. Sign in using the instructions for your selected agent below.

### Claude Code

First run:

```
claude
/login
```

Choose **"Claude account with subscription"**, open the printed URL on any
device, approve, copy the code, paste it back. No browser needed on the HA
host itself. This only has to be done once - the login persists across
add-on restarts and updates.

### ChatGPT (OpenAI Codex)

1. Open the sidebar panel and click **ChatGPT** (or press **Ctrl+Shift+2**).
   It launches Codex without restarting the add-on.
2. Enable **device code login** in your ChatGPT security settings. For a
   managed workspace, an admin may need to enable it.
3. Choose **Sign in with Device Code** in Codex. Open the displayed URL on
   your phone or computer, sign in to ChatGPT, and enter the code **in that
   browser**. No browser or localhost callback is needed on the HA host.
4. Complete Codex's workspace trust prompts for `/homeassistant`. Use `/mcp`
   to check the `homeassistant` tools and `/model` to choose among the models
   your account can use.

From an SSH shell or the panel's **Shell** button, the equivalent
commands are:

```sh
codex login --device-auth
codex login status
codex
```

This runs OpenAI's Codex terminal agent using your ChatGPT account. ChatGPT
sign-in requires account access to Codex and is subject to that account's
usage limits. The add-on does not import chats or memory from the ChatGPT
website. See [OpenAI's authentication documentation](https://developers.openai.com/codex/auth/)
for sign-in requirements and device code troubleshooting.

Codex can also use an OpenAI API key with separate API billing. To enter a key
from a shell without putting it in command history:

```sh
read -rsp 'OpenAI API key: ' codex_api_key; printf '\n'
printf '%s' "$codex_api_key" | codex login --with-api-key
unset codex_api_key
```

Every terminal sets `CODEX_HOME=/data/codex`. Credentials (`auth.json`),
settings (`config.toml`), and saved sessions stay there across updates. A new
config uses file-based credential storage; existing settings are preserved.
Run `codex resume` to reopen a saved conversation after restarting. Click
**Claude** to return to Claude's live session with its own login intact.

The built-in MCP server uses the add-on's Supervisor token at runtime; no HA
token or API key needs to be copied into Codex's config. An existing
`homeassistant` MCP entry is kept as configured, including disabled tools or
an explicitly disabled server. Codex's normal
approval and sandbox settings apply. Start with a read-only request such as
"List my Home Assistant lights and their current state using the homeassistant
tools."

## What you get

- **Persistent login** - stored under `/data`, survives restarts/updates.
- **Two ways in** - the sidebar Ingress panel, and SSH (for VS Code Remote-SSH,
  full IDE experience against `/homeassistant`).
- **Live agent switching and task workspaces** - each workspace/agent pair has
  a separate tmux session. The panel and SSH can attach to the same pair, so a
  long-running task keeps going if you close the browser tab or your SSH
  connection drops.
- **Built-in `homeassistant` MCP server** - gives the agent structured tools
  instead of hand-rolled `curl`: `ha_list_entities`, `ha_get_entity_state`,
  `ha_call_service`, `ha_render_template`, `ha_list_services`,
  `ha_get_error_log`. No token to configure - it uses the add-on's own
  Supervisor token.
- **GitHub CLI (`gh`)** - run `gh auth login` once; the login is kept in
  `/data/gh`, and git uses it for HTTPS pushes/pulls to GitHub.
- **`ha` CLI** on PATH for Supervisor-level operations (`ha core restart`, etc.).

## Switching agents and workspaces

The top bar is available on desktop and phones. Choose **Claude**, **ChatGPT**,
or **Shell**; keyboard shortcuts are **Ctrl+Shift+1**, **Ctrl+Shift+2**, and
**Ctrl+Shift+3** respectively. Use the buttons if your browser or OS reserves
a shortcut. The workspace selector chooses the task folder.

Switching detaches the current terminal and attaches the selected session.
An agent keeps working while you are viewing another one. Returning to the
same workspace and agent reconnects to that live process, including its
conversation. Conversations are separate; switching does not transfer chat
history between providers. Sign in to each provider once.

The browser remembers your selection. The `agent` option supplies the first
choice in a new browser. An existing `web_command` adds a **Custom** button
and supplies the initial choice; the Claude, ChatGPT, and Shell buttons still
launch their own commands. With `mobile_ui: false`, the stock ttyd client has
no selector and starts the configured default.

SSH can attach to the same sessions:

```sh
agent-session --agent codex --workspace homeassistant
agent-session --agent shell --workspace automations
```

Closing the page or switching away only detaches. Exiting the CLI ends its
process; an open panel reconnects and starts a fresh one. To stop a session
without relaunching it, switch to Shell, then use `tmux kill-session -t
=agent-WORKSPACE-AGENT` with the relevant IDs. A full add-on restart stops all
live sessions.

### Task workspaces and skills

Click **Shell**, then create a workspace:

```sh
agent-workspace create automations "HA automations"
agent-workspace create dashboards "Dashboard work"
agent-workspace list
```

Reload the panel to see new workspaces in its selector. The existing sessions
stay alive. These examples create persistent folders under
`/share/agent-terminal/workspaces/`. Workspace registrations live under
`/data/agent-terminal/workspaces/` and survive updates.

Each newly created folder contains:

| Path | Purpose |
|---|---|
| `AGENTS.md` | Shared task goals, coding conventions, relevant paths, and checks. Edit this to describe the workspace's job. Codex reads it directly. |
| `CLAUDE.md` | Imports `AGENTS.md` so Claude reads the same instructions. |
| `.agents/skills/` | Add a folder per skill with its own `SKILL.md`. Codex discovers these project skills. |
| `.claude/skills` | Links to the same skill directory for Claude. |

For example, a skill file at `.agents/skills/check-automations/SKILL.md` needs
YAML frontmatter with `name: check-automations` and a `description` saying when
to use it, followed by its instructions. Use the common skill format for
shared skills; provider-specific options may behave differently. Restart the
CLI in that workspace after changing instructions or skills so it reloads them.
See [Codex skills](https://developers.openai.com/codex/skills/),
[Claude skills](https://code.claude.com/docs/en/skills), and
[Claude's AGENTS.md import](https://code.claude.com/docs/en/memory).

To register an existing project, supply an absolute path:

```sh
agent-workspace create my-addon "My add-on" /addons/my-addon
```

Existing folders are left untouched, so keep or add the project's own
instructions and skills there. Registering a workspace does not clone a
repository or install dependencies. Agents and shells start in the selected
folder; commands such as `npm install` can set up that project's dependencies.
The built-in **Home Assistant** workspace continues to use `/homeassistant`.

Workspaces organize files, instructions, and conversations within the **same
container**. They share provider logins, installed tools, mounted files, and
Supervisor access. They are **not security sandboxes**, and `AGENTS.md` is
guidance, not a permissions boundary. An agent working on a separate project
can still access HA. Concurrent agents can edit the same files; use separate
project folders or Git worktrees when tasks need independent changes.

## Copy and paste (sidebar panel)

- **Copy:** drag-select in Claude Code and it's copied (a "Copied N
  characters" toast confirms). Or **Shift+drag** (Option+drag on a Mac) to
  select anything on screen, then Ctrl+C / Ctrl+Shift+C / ⌘C or right-click →
  Copy. Ctrl+C copies only while text is selected, otherwise it interrupts.
- **Paste:** Ctrl+V / Ctrl+Shift+V / ⌘V, or right-click → Paste (needs HTTPS).
  On a phone, tap 📋 (or long-press → Paste): a paste box opens with the
  keyboard. Long-press in it and choose Paste (or tap the keyboard's clipboard
  suggestion) and it goes straight to the terminal. Typed text needs **Send**.
- **Esc twice on a phone:** tap **⋯**, then **Esc²**.
- **On a phone, long-press the terminal** for a menu: Select text…, Copy
  screen, Paste.
- **Copy on a phone:** scroll to what you want, then long-press → **Select
  text…** (or tap **Copy** on the key bar). The screen opens as plain text:
  select with your phone's handles and tap **Copy**, or **Copy all**. **Done**
  goes back.
- **Right-click** opens the terminal's menu; **Shift+right-click** opens the
  browser's. Tick **Right-click pastes** in that menu for Windows Terminal
  behaviour: right-click copies the selection, or pastes when nothing is
  selected, and Shift+right-click opens the menu.

## Options

| Option | Default | Description |
|---|---|---|
| `authorized_keys` | `[]` | SSH public keys allowed to log in. Empty = SSH effectively unusable (no keys accepted). |
| `ssh_port` | `2202` | Port sshd listens on. Also update the add-on's `ports` mapping if you change this. |
| `agent` | `claude` | Initial choice: `claude` (Claude Code) or `codex` (ChatGPT via OpenAI Codex). Switch live with the panel buttons. |
| `web_command` | *(empty)* | Optional trusted shell command for the separate Custom session and initial web selection. Use the Shell button for a plain shell. |
| `mobile_ui` | `true` | Serve the terminal with agent/workspace controls and touch support. Set `false` for ttyd's stock client without these controls. |
| `git_user_name` / `git_user_email` | `""` | Optional system-wide git identity for commits made from this add-on. |

## Using it from a phone

The sidebar panel serves a terminal page built for touch, so the add-on is
usable from the Home Assistant companion app:

- **Drag anywhere on the terminal to scroll.** Claude Code (like most TUI agents) asks the terminal for
  mouse tracking and scrolls on wheel events; a touchscreen never produces one,
  which is why long output used to be unreachable. Drags are translated into
  wheel events, so scrolling also works in `less`, in shell scrollback, and in
  anything else running here.
- **Answer Codex questions:** tap **Answer** (Shift+Left), use the arrows to
  choose an option, then **Enter** to confirm. Tab moves between fields.
- **Write a prompt:** tap the terminal, **Write**, or **⌨** to open the phone
  keyboard and draft box. Type or paste your prompt, then
  tap **Insert**. Review the text in the terminal and tap **Enter** to submit.
  Phone autocorrect and composition edits stay in the draft; only the finished
  value is pasted into Codex or Claude. Insert waits for composition to finish
  and does not automatically submit the prompt. Ordinary Enter in the draft
  adds a line; Ctrl+Enter inserts the draft when composition is finished.
  Each draft starts with a fresh editor; reopening an active draft preserves
  its text and composition. Write supports native autocorrect, while the
  separate Paste action keeps correction disabled for literal pasted text.
- **Essential keys stay visible:** `Esc`, `Tab`, `Answer`, `Enter`, arrows,
  `Ctrl`, `Alt`, `Shift`, `Shift+Tab`, `Ctrl+C`, and `↵` (Ctrl+J for a newline
  in Codex). Sticky modifiers apply to the next key: `Shift` then `←` also
  opens Codex questions; `Ctrl` then `r` sends Ctrl+R.
- **More keys:** tap **⋯** for `Esc²`, `Backspace`, `Home`/`End`, page scrolling,
  the `tmux` prefix (Ctrl+B), Copy/Paste, text size, and the original direct
  terminal keyboard (**Keys**). Arrows, scrolling, and backspace repeat when held.
  `tmux` then `[` enters scroll mode; `tmux` then `d` detaches. These use the
  add-on's default tmux prefix.
- **Claude controls remain available:** Shift+Tab, Esc², Ctrl+C, all navigation
  keys, and copy/paste keep their terminal sequences. **Answer** is a Codex
  shortcut; it sends Shift+Left to whichever program is running.
- **Direct phone typing:** **⋯ → Keys** opens the original terminal keyboard for
  single-key interactions or applications that need it. Disable autocorrect on
  your phone keyboard when using this mode. The native draft is the default
  phone entry path because xterm's live IME handling can replay old text (see
  [upstream report](https://github.com/xtermjs/xterm.js/issues/6078)). The direct
  keyboard remains subject to that upstream limitation. Physical keyboards
  continue to work normally. With `?keys=0`, direct phone typing is preserved.
- **Easier keyboard access:** phone keys are at least 44 pixels high. Keyboard
  actions focus the editor on a completed tap, which mobile browsers require
  to show the keyboard. Scrolling, long-press menus, and cancelled touches do
  not open the draft.
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
4. Add its ID to `agent-session`'s validated mode list and the agent metadata
   in `workspaces.mjs` (and the fallback in `index.template.html`). The first
   three toolbar entries have Ctrl+Shift+1 / 2 / 3 shortcuts.

Switching `agent` keeps each agent's data in its own `AGENT_DATA`, so logins
survive switching back and forth.

### Checking the Codex adapter

With Python 3.11+, Bash, Node, and the Codex version pinned in `codex.sh` on
PATH, install the MCP server's dependencies and run from the repository root:

```sh
npm install --prefix agent-terminal/rootfs/opt/ha-mcp --no-package-lock
python3 -m unittest discover -s tests -v
node --test tests/test_*.mjs
```

These checks use the real CLI to register and inspect MCP servers in temporary
directories. They verify that settings, credentials, and saved sessions are
preserved, tool restrictions survive restarts, malformed TOML is rejected,
and Codex discovers the built-in HA tools. They do not sign in or make model
requests.

The `Validate add-on` GitHub Actions workflow builds complete images on native
AMD64 and ARM64 runners and runs the checks inside each image. It also tests
first-boot option import, SSH/login environments, tmux, agent switching, and
the Supervisor token-file fallback against a local mock HA API.
Node tests cover workspace validation and persistence, safe HTML metadata,
out-of-order browser connections and clipboard input, and real ttyd WebSocket
sessions with stub provider commands. They verify that switching preserves
processes, separates workspaces, keeps login-shell working directories, and
serves newly created workspaces without restarting ttyd.
`tests/container-smoke.sh` is only for these disposable test containers.
Live ChatGPT sign-in and operations against a real HA instance are manual
acceptance checks after installation.

### Checking the terminal controls

With Node 22+, run from the repository root:

```sh
node tests/test_webui_keys.mjs
```

These checks execute the page's handlers with a simulated DOM, xterm API, and
WebSocket. They cover the question-answer sequence, modifiers, Claude controls,
pointer repeat, keyboard activation, and draft composition/paste handling.
They make no model requests and do not send keys to a live session.

For browser regression coverage, build the web UI with its normal build script,
then point the test at Chromium and the resulting bundle:

```sh
CHROMIUM_BIN=/usr/bin/chromium WEBUI_BUNDLE=/path/to/index.html node tests/test_webui_browser.mjs
```

The browser test uses real touch activation and composition events with the
bundled xterm, including repeated word replacement, Korean composition, and
live Ctrl/Answer/arrow/Enter controls. Its WebSocket is replaced before page
code runs, so all input stays inside the test. The test skips unless
`CHROMIUM_BIN` is set. Actual phone keyboard behavior still needs a device check.

## Known limitations

- The live tmux process and any running task do **not** survive a full add-on
  restart or update. Login and settings persist; Codex's saved conversations
  can be reopened with `codex resume`. Detach/reattach across browser or SSH
  drops keeps the live process running.
- The first `http://supervisor/core/api/...` call right after boot can return
  `502` for a few seconds while the proxy warms up - retry.
- Editing `custom_components/*.py` still requires `ha core restart` to take
  effect (Python module caching).
- Tested on amd64/aarch64 HAOS. Not tested on armv7/armv6.

## Support

This is a personal add-on, shared as-is with no support commitment. Read the
source before you install it - it's short enough to actually read.
