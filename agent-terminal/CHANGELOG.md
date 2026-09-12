# Changelog

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
