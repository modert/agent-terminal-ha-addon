# Changelog

## 2.2.0
- Add **ChatGPT via OpenAI Codex**: select `agent: codex` and sign in using
  the device code flow from any browser. Claude remains the default.
- Install Codex CLI 0.154.0 alongside Claude Code in both architecture builds.
- Persist Codex login, configuration, and saved conversations in `/data/codex`.
  Use `codex resume` to reopen a saved conversation after an add-on restart.
- Register the existing Home Assistant MCP tools using Codex's native config
  editor, preserving unrelated settings and refusing malformed TOML.

## 2.1.0
- GitHub CLI (`gh`) is installed in the image.
- `gh auth login` now survives restarts and updates: its config is kept in
  `/data/gh`, and git is set up at boot to use it for github.com over HTTPS.
- The one-time import also brings over a `gh/` folder, so an exported gh
  login carries across the slug change.

## 2.0.0
- **Breaking:** slug is now `agent_terminal` (was `claude_code`). Home Assistant
  treats this as a new add-on with its own empty `/data`, sidebar URL and
  options, so the old one has to be replaced rather than updated.
- One-time import on first boot: if `/share/agent-terminal/import/` exists,
  its `claude/` and `ssh/` folders are copied into `/data` (never over
  existing data), `options.json` there is applied as the add-on's options,
  and the import folder is deleted so credentials don't linger in `/share`.
  To move an existing `claude_code` install, run this inside it first:
  ```
  mkdir -p /share/agent-terminal/import && chmod 700 /share/agent-terminal
  cp -a /data/claude /data/ssh /data/options.json /share/agent-terminal/import/
  ```
  Then stop the old add-on (both use port 2202), install and start this one.

## 1.3.0
- Renamed to **Agent Terminal** and restructured around agent adapters, so a
  CLI other than Claude Code can be added without touching the rest of the
  add-on. Claude Code is still the only adapter.
  - Everything agent-specific (install, config dir, env, MCP registration,
    login help) lives in `/opt/agents/<agent>.sh`; see "Adding an agent" in
    DOCS.md.
  - New option `agent` (only `claude` for now). `web_command` now defaults
    to the agent's own command.
  - tmux session is `agent`, attached with `agent-session`; `claude-session`
    still works.
- The slug stays `claude_code` and Claude's data stays in `/data/claude`, so
  updating keeps the existing login.

## 1.2.1
- Web terminal now shrinks above the on-screen keyboard inside the HA app/frontend.
  The panel is an iframe, and the keyboard only resizes the outer page, so the
  layout now measures the visible part of the frame in the top window.
- `?debug=1` on the panel URL shows the viewport numbers the layout uses.

## 1.2.0
- Web terminal is now usable on a phone. The Ingress panel serves its own
  terminal page (xterm.js, inlined into a single file that ttyd hands out
  with `--index`) instead of ttyd's stock client:
  - **Drag to scroll.** Claude Code turns on mouse tracking and scrolls on
    wheel events, which a touchscreen never produces - so long output was
    unreachable. A drag on the terminal is now translated into wheel events,
    which also works for plain scrollback and for full-screen programs.
  - **On-screen keys** for what mobile keyboards leave out: Esc, Tab,
    Shift+Tab, arrows (hold to repeat), page up/down, Home/End, Backspace,
    Ctrl+C, and sticky Ctrl/Alt. Second row toggles with `...`.
  - **Keyboard-aware layout.** The terminal is sized from `visualViewport`, so
    the on-screen keyboard no longer pushes the prompt off-screen and the
    page never has to be scrolled.
  - Text size buttons (remembered per device), a keyboard show/hide key, and
    automatic reconnect when the tab wakes up.
  - The key bar only appears on touch devices; desktop is unchanged.
  - New option `mobile_ui` (default `true`) falls back to ttyd's stock client.

## 1.1.1
- Fix: with `CLAUDE_CONFIG_DIR` set, Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json`,
  not `~/.claude.json` - MCP registration now targets the right file, non-destructively.

## 1.1.0
- Add persistent tmux session (`claude-session`) shared between the Ingress panel
  and SSH; survives disconnects.
- Add a built-in `homeassistant` MCP server (`/opt/ha-mcp`) with entity/service/
  template tools over the Supervisor API.

## 1.0.0
- Initial release: Claude Code CLI with persistent Claude-account (subscription)
  login, Ingress web terminal (ttyd), and SSH (VS Code Remote-SSH support).
