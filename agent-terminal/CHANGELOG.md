# Changelog

## Unreleased

## 2.7.1
- Make Ctrl+Left/Right move by word, Ctrl+Backspace delete the previous word,
  and Ctrl+Delete delete the next word in the web terminal. Mac Option uses
  the same word shortcuts. Preserve text-field editing and Shift combinations.
- Run the real Chromium interaction suite in CI on both architectures, with
  word-editing, split-pane routing, and real ttyd/tmux/readline coverage.

## 2.7.0
- Create and rename independent sessions of the same provider and workspace.
  Existing provider buttons keep their Main sessions and persistent logins.
- Find sessions by task, purpose, provider, or workspace with Sessions or
  Ctrl+Shift+K (⌘Shift+K on a Mac). The picker groups tasks by workspace, adds
  provider icons and visible-pane labels, and tucks away unused defaults.
  Edit task names and optional purpose notes without restarting a session.
  Names, notes and stop state are shared across browsers.
- Open two sessions side by side on wide screens, resize the divider, and
  restore the split after reloading. Narrow screens show one session.
  Split view immediately opens a second pane with its own task picker; choose
  an existing session or create one there while the left terminal stays visible.
  Canceling an empty pane starts nothing. Closing a pane leaves its agent running.
- Stop a session from its menu without another browser reconnecting and
  restarting it. Start explicitly launches a fresh process.
- Preserve independent terminal input, clipboard actions and mobile controls
  in each pane. Add lifecycle, concurrency, browser and ttyd integration checks.

## 2.6.1
- Update the Codex CLI to 0.159.3.

## 2.6.0
- A keyboard button at the right end of the top bar shows or hides the
  helper keys on any device, and each device remembers the choice. Desktops
  can bring up Esc, Mode, Esc², Ctrl+C and the rest when a keyboard lacks a key
  or the browser takes a shortcut. Clicking them keeps the terminal focused.
  Phones and tablets can hide them and type into the terminal directly.
  `?keys=1` / `?keys=0` still override the choice for one visit.
- On wide screens the helper keys form a compact centred keypad instead of
  stretching edge to edge.
- Direct is highlighted while its keyboard is open, and is left out on
  desktops, where typing already reaches the terminal.
- Touchscreens no longer leave the agent buttons looking pressed after a tap.
- The top bar collapses (⌃) to a slim strip naming the agent and workspace,
  giving a phone about four more lines of output. The strip brings it back.
  Both keep a draft and the phone keyboard open, and each device remembers
  the choice.
- A phone turned on its side puts the helper keys in a column beside the
  terminal and shrinks the draft to one line. With the keyboard up, the
  terminal keeps about five rows instead of one.
- Coming back to the page, or back online, reconnects at once rather than
  waiting out a retry delay that grew while the phone slept.
- The always-visible bottom row now carries keys: Esc, ← ↑ ↓ →, Enter and
  Keys. Write is gone, because a tap on the terminal already opens the draft;
  New line is ↵ beside the draft.
- Keys opens a single row instead of up to three: the Agent, Ctrl, Edit or
  Tools group, with a group button above Keys that lists the groups in the
  same row. It replaces More and Back and never moves, so a second tap undoes
  the first. Controls are outlined, and Keys is set slightly apart from Enter.
- Ctrl+C joins the agent keys (Tab, Mode, Answer, Esc², Ctrl+C, Space), since
  both agents clear typed input with it. They line up with the bottom row, and
  the group button sits right above Keys.
- Below 350px wide, the seven-key rows are 40px wide rather than 44.
- Fix taps on the terminal sometimes not opening the draft, and drags that
  started on text stopping after a line. xterm replaces a row's elements when
  it redraws it, and the rest of the touch went to the removed element.

## 2.5.0
- Selecting text copies it, everywhere and without a key press: an xterm
  selection copies when the drag settles, the phone's own handles copy inside
  the text sheet, and tmux copy-mode and the agents' own selections keep
  arriving through OSC 52. Ctrl+C and the menu still copy and confirm, so
  nothing depends on Ctrl+C, which stays the interrupt when nothing is
  selected.
- Fix ChatGPT sessions reloading forever on Codex 0.157: its new background
  app-server cannot stay alive in the add-on container, so the TUI exited with
  "failed to record pid-managed app-server process ... startup". Turn
  `daemon_auto_start` off in the stored Codex config, for existing installs too,
  and pin the CLI to 0.158.0.
- Start phone helper keys minimized with a small Write / New line / Keys row.
  Opening a new draft or switching sessions minimizes them; explicit expansion
  survives keyboard resizing. More replaces common controls with a compact
  tools page, and collapsing clears armed modifiers.
- Consolidate shared Claude/Codex actions: Enter, Esc, Tab, Mode (Shift+Tab),
  Esc², arrows, Space, and newline. Keep Codex Answer (Shift+Left) alongside
  them and preserve Ctrl/Alt/Shift, Ctrl+C, clipboard, navigation, text size,
  tmux prefix, and direct keyboard access under More.
- Combine the duplicate phone keyboard buttons into Write. Keep its native
  draft below the terminal so output remains visible and scrollable. Enter or
  Send submits; Shift+Enter and New line add a line. Use a compact session
  header when the keyboard leaves little vertical space.
- Keep autocorrect and composition within a fresh native editor per draft;
  submit the final value once after composition commits. Ignore late events
  from previous drafts and preserve active drafts on duplicate open attempts.
- Open the keyboard on completed taps, preserve it while navigating helper
  pages, and avoid opening it after scroll/cancel gestures. Prevent touch
  clicks from sending keys twice. Use 44-pixel phone targets and font-independent
  navigation arrows, accessible expansion state and visible armed modifiers.
- Add isolated event and Chromium tests for helper state, touch activation,
  narrow-phone layout, shared terminal sequences, word replacement, composition,
  Enter submission, and scrolling while composing.

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
