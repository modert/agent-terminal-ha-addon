# Agent Instructions — Agent Terminal add-on

Source for the Agent Terminal Home Assistant add-on (`agent-terminal/`). User-facing documentation is `agent-terminal/DOCS.md`, which also covers the test suites and the agent adapter contract. This file covers working on the add-on from inside a running copy of it.

## You are probably running inside this add-on

Claude Code and Codex in the Home Assistant install run in this add-on's container, so rebuilding or restarting the add-on kills the session doing the work. Test changes by hot-deploying them into the live container, commit them here, and let the user rebuild when they're ready.

The installed add-on (`local_agent_terminal`) is built from this directory. `/addons/agent-terminal` is an older untracked copy (2.3.0 against 2.4.0 here); check which one Supervisor reports before assuming it matters.

The user also pushes to this repo from other machines, so `git fetch` before committing.

## Hot-deploying the web UI

The terminal page is a custom xterm.js client. `agent-terminal/rootfs/opt/webui/index.template.html` is built by `build.mjs` into `/opt/webui/index.html`; ttyd serves `/run/agent-terminal/index.html`, which `agent-workspace refresh-ui` renders from the built file. ttyd re-reads the page on every request, so the deploy loop is:

1. Write the new `/opt/webui/index.html`.
2. Run `agent-workspace refresh-ui`.
3. Reload the browser. No restart is needed.

`build.mjs` can't run in the live container, because the image deletes `/opt/webui/node_modules` after building. Recover the inlined xterm CSS and JS from the existing `/opt/webui/index.html` instead: split the *old* template on its `/*{{XTERM_CSS}}*/`, `/*{{XTERM_JS}}*/` and `/*{{FIT_JS}}*/` markers, walk those literal segments through the built file (the text between them is each inlined body), and substitute the bodies into the edited template. Then extract every `<script>` from the result and run `node --check` on it.

tmux options apply live with `tmux set`.

## Tests in the live container

The container has Node but no Python.

- Runs here: `node --test tests/test_webui.mjs`, `tests/test_webui_keys.mjs`, `tests/test_workspaces.mjs`. Their `Terminal` stub has to gain any new xterm API the page starts calling. `tests/test_webui_browser.mjs` skips unless `CHROMIUM_BIN` is set.
- Doesn't run here: `tests/test_codex_adapter.py`, `tests/test_mcp_integration.py` and `tests/container-smoke.sh`. Check adapter shell functions by sourcing `agent-terminal/rootfs/opt/agents/<agent>.sh` with a temporary `AGENT_DATA`; CI runs the full suites.

## Codex gotcha

Codex 0.157 and later start a background app-server that dies in this container. The TUI then exits with "failed to record pid-managed app-server process" and ttyd respawns it forever, which looks like the ChatGPT panel loading endlessly. On every boot, `codex.sh`'s `agent_init` adds `daemon_auto_start = false` to `/data/codex/config.toml` when the setting is missing (inside an existing `[features]` table if there is one) and leaves any existing value alone, including a deliberate `true`. If the panel loops after a Codex update, check `codex features list | grep daemon_auto_start` first; `codex --no-daemon` is the one-off escape.
