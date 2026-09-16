# Changelog

## Unreleased
- Add visible Answer (Shift+Left) and Enter buttons for Codex questions, plus
  a sticky Shift modifier, Ctrl+J newline, and a tmux prefix button.
- Add a Write draft box for phone input. Autocorrect edits stay in the box;
  Send submits the final text once, after composition finishes. The original
  direct terminal keyboard is available under More > Keys.
- Keep Write in a compact input area below the terminal so responses remain
  visible and scrollable. Enter/Send submits; Shift+Enter and ↵ add a line.
  Handle Android Enter events without rewriting the active editor's value.
- Open the native draft from a terminal tap, Write, or the keyboard icon.
  Wait for completed taps before focusing the editor, enlarge phone keys to
  44 pixels high, and avoid opening the keyboard after scroll/cancel gestures.
  Keep live terminal shortcuts available through the explicit Keys action.
- Prevent touch-generated clicks from sending a toolbar key twice or toggling
  a sticky modifier back off.
- Give each Write draft a fresh native editor with autocorrect enabled. Ignore
  late composition events from closed drafts and prevent duplicate openings
  from resetting the value or composing range while the user is editing.
- Cover browser touch activation, repeated word replacement, and composition
  commits with an optional Chromium test using the real bundled xterm.
- Preserve Claude's Shift+Tab, Esc², Ctrl+C, navigation, and clipboard controls.
  Extra keys wrap and remain accessible under More.
- Add keyboard activation and modifier state labels for assistive technology,
  plus automated checks for key sequences and phone draft input.

## 2.4.0
- Switch Claude, ChatGPT, and Shell with panel buttons or Ctrl+Shift+1 / 2 / 3,
  without changing add-on options or restarting. Each workspace/agent pair
  keeps its own live tmux session when you switch away or disconnect.
- Workspace selector and `agent-workspace create ID "Name" [DIRECTORY]`.
  New folders get shared `AGENTS.md` instructions, a Claude import, and linked
  skill directories. Existing project folders are registered without edits.
- Both agents' persistent environments and HA MCP tools initialize at boot.
  Existing Claude MCP entries are now preserved, like Codex's.
- Keep `web_command` as a separate Custom session; `agent` is the initial
  choice. Remember the selected workspace and agent in the browser.
- Validate session IDs, isolate per-session working directories, and discard
  stale connections, clipboard reads, and delayed keys after switching.

## 2.3.0
- Copy works in the web terminal. Selecting text with the mouse in Claude Code
  now lands in your browser clipboard. tmux passes OSC 52 copies through
  (`set-clipboard on`) and the page writes them to the clipboard, with a
  fallback for plain-HTTP access.
- Shift+drag (Option+drag on a Mac) makes a browser-side selection. Ctrl+C
  copies it while something is selected and still interrupts otherwise;
  Ctrl+Shift+C / ⌘C also copy.
- Ctrl+V pastes the browser clipboard instead of sending ^V.
- Right-click menu in the terminal: Copy, Paste, Select all, Clear selection.
  Shift+right-click still opens the browser's own menu.
- Optional "Right-click pastes" (toggle in that menu, remembered per browser):
  right-click copies the selection if there is one, otherwise pastes;
  Shift+right-click then opens the menu.
- 📋 Paste key on the on-screen key bar's second row.
- Long-press menu on touchscreens: Select text…, Copy screen, Paste.
- Copying on a phone: **Select text…** (or the new **Copy** key) opens the
  current screen as plain text; select it with the phone's own handles and
  tap Copy (or Copy all). Also in the right-click menu as "Screen as text…".
- Paste box: on touchscreens Paste always opens a text box (the browser's
  clipboard permission is too unreliable there); on desktops it's the
  fallback when clipboard access is refused. A paste into the box goes
  straight to the terminal; typed text is sent with Send (or Ctrl+Enter).
- Sheet buttons (Copy / Copy all / Done, Send / Cancel) moved to the bottom,
  full-width and larger, with the main action highlighted.
- Touchscreens keep at least half a key of space below the key bar, clear of
  rounded screen corners.
- **Esc²** key: sends Esc twice for Claude Code's rewind / clear input.

## 2.2.0
- Add **ChatGPT via OpenAI Codex**: select `agent: codex` and sign in using
  the device code flow from any browser. Claude remains the default.
- Install Codex CLI 0.154.0 alongside Claude Code in both architecture builds.
- Persist Codex login, configuration, and saved conversations in `/data/codex`.
  Use `codex resume` to reopen a saved conversation after an add-on restart.
- Register the existing Home Assistant MCP tools using Codex's native config
  editor, preserving unrelated settings and refusing malformed TOML.
- Preserve existing MCP entries, including disabled servers and tool filters,
  across restarts. Resolve the selected agent after importing saved options.

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
