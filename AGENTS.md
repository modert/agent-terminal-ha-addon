# Agent Instructions — Agent Terminal add-on

Source for the Agent Terminal Home Assistant add-on (`agent-terminal/`). User-facing documentation is `agent-terminal/DOCS.md`, which also covers the test suites and the agent adapter contract. This file covers working on the add-on from inside a running copy of it.

## You are probably running inside this add-on

Claude Code and Codex in the Home Assistant install run in this add-on's container, so updating, rebuilding or restarting the add-on kills the session doing the work. Test changes by hot-deploying them into the live container, and ship them through a pull request.

Home Assistant installs this add-on from the add-on store (`62afb2b9_agent_terminal`), built from `master` of this repository. It offers an update when `version` in `agent-terminal/config.yaml` changes on `master`, so a release is a PR that bumps the version and adds a changelog heading (the daily Codex update PR does this and merges itself once CI passes). `master` accepts only pull requests whose CI passes.

The Codex update PR is opened with the `CODEX_UPDATE_TOKEN` repository secret, a personal access token. Without it the PR belongs to `github-actions[bot]`, and GitHub holds its checks until someone approves them on the PR page, so a Codex update PR that sits unmerged usually means the token is missing or has expired.

A checkout under `/addons` also shows up in Home Assistant as a local add-on with the same name. Don't install or rebuild that one; it would be a second copy.

The user also pushes to this repo from other machines, so `git fetch` before committing.

## A pull request you open waits unseen

Agents here push with the owner's GitHub login, and GitHub sends nobody a notification about their own pull request. Only the daily Codex update merges itself. Anything else you open stays open, with green checks and no one told, until the owner happens to look. So never leave one without doing one of these:

- **Asked to ship it:** turn on auto-merge once the PR is ready, `gh pr merge <number> --auto --squash`. It merges when "Validate add-on" passes. Check that it did, or say that it hasn't.
- **It needs the owner** (a draft, something to try on a phone, a decision): send an alert to their phone. One tag per PR, so a later call replaces the alert instead of stacking another:

  ```sh
  curl -sf -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" -H 'Content-Type: application/json' \
    http://supervisor/core/api/services/notify/notifications_owner -d '{
      "title": "Agent Terminal: PR #<number> is waiting on you",
      "message": "<title>. <the one thing they need to do>",
      "data": {"tag": "agent_terminal_pr_<number>", "group": "system", "channel": "system",
               "clickAction": "https://github.com/modert/agent-terminal-ha-addon/pull/<number>"}}'
  ```

  `notify.notifications_owner` is the owner's own group in the Home Assistant config (`/homeassistant/notify.yaml`). Clear the alert when the PR merges or closes: the same call with `"message": "clear_notification"` and only the `tag` in `data`.

Whenever something merges to `master`, run `gh pr list` afterwards. A merge can leave another open PR conflicting, most often over `version` and the changelog: the Codex update takes the next patch version on `master` every time Codex releases, so a PR that bumps the version too goes stale within a day. Bump the version last, and merge `master` into the branch before asking for a merge.

End your report with what is still open and the one thing the owner has to do about each.

## Hot-deploying the web UI

The terminal page is a custom xterm.js client. `agent-terminal/rootfs/opt/webui/index.template.html` is built by `build.mjs` into `/opt/webui/index.html`; ttyd serves `/run/agent-terminal/index.html`, which `agent-workspace refresh-ui` renders from the built file. ttyd re-reads the page on every request, so the deploy loop is:

1. Write the new `/opt/webui/index.html`.
2. Run `agent-workspace refresh-ui`.
3. Reload the browser. No restart is needed.

`build.mjs` can't run in the live container, because the image deletes `/opt/webui/node_modules` after building. Recover the inlined xterm CSS and JS from the existing `/opt/webui/index.html` instead: split the *old* template on its `/*{{XTERM_CSS}}*/`, `/*{{XTERM_JS}}*/` and `/*{{FIT_JS}}*/` markers, walk those literal segments through the built file (the text between them is each inlined body), and substitute the bodies into the edited template. The other markers, `/*{{SESSIONS_JS}}*/`, `/*{{UPLOADS_JS}}*/` and `/*{{VOICE_JS}}*/`, take `sessions.js`, `uploads.js` and `voice.js` from the checkout, with `</script` escaped the way `build.mjs` does it. Then extract every `<script>` from the result and run `node --check` on it. Deploy the matching template and build script alongside the bundle so the next hot deploy can recover its inline assets.

ttyd starts `/usr/local/bin/agent-session` for each new connection, and that starts `/opt/agent-terminal/sessions.mjs`, `uploads.mjs` or `voice.mjs` for the control connections, so copying those files into place takes effect on the next connection. To try one before replacing the live copy, run a second ttyd on another port against the checkout's `agent-session`.

tmux options apply live with `tmux set`.

## Tests in the live container

The container has Node but no Python.

- Runs here: `node --test tests/test_webui.mjs`, `tests/test_webui_keys.mjs`, `tests/test_workspaces.mjs`, `tests/test_sessions.mjs`, `tests/test_uploads.mjs`. The page tests' `Terminal` stub has to gain any new xterm API the page starts calling. `tests/test_webui_browser.mjs` skips unless `CHROMIUM_BIN` is set; point `WEBUI_BUNDLE` at a bundle built as above.
- Never set `AGENT_TERMINAL_TEST_CONTAINER=1` here: `tests/test_terminal_container.mjs` then runs and kills the tmux server, and every live session with it.
- Doesn't run here: `tests/test_codex_adapter.py`, `tests/test_mcp_integration.py` and `tests/container-smoke.sh`. Check adapter shell functions by sourcing `agent-terminal/rootfs/opt/agents/<agent>.sh` with a temporary `AGENT_DATA`; CI runs the full suites.

## Codex gotcha

Codex 0.157 and later start a background app-server that dies in this container. The TUI then exits with "failed to record pid-managed app-server process" and ttyd respawns it forever, which looks like the ChatGPT panel loading endlessly. On every boot, `codex.sh`'s `agent_init` adds `daemon_auto_start = false` to `/data/codex/config.toml` when the setting is missing (inside an existing `[features]` table if there is one) and leaves any existing value alone, including a deliberate `true`. If the panel loops after a Codex update, check `codex features list | grep daemon_auto_start` first; `codex --no-daemon` is the one-off escape.

`agent_init` adds `disable_paste_burst = true` the same way. Codex otherwise takes an Enter that arrives within about 10 ms of the key before it for a line break in a paste, and the prompt stays in the composer. A browser, Home Assistant's proxy, ttyd and tmux bunch keys that closely often enough to matter. A prompt left unsent in Codex is that setting missing, or a Codex started before it was added.

## Input that does not arrive

Three things in the page keep keys with the session they were typed for; check them before blaming the agent. In split view only the pane being typed in may focus its terminal when a connection opens (`otherPaneHasKeyboard`). Keys typed before tmux has drawn the session are held and released on the first output (`held`, `releaseInput`), because ttyd starts the launcher on a terminal in line mode, which echoes keys and turns Enter into a line break. An Enter pressed during an upload waits for the file's path.

To see what a session really receives, run a second ttyd on another port whose command attaches to a separate tmux server (`tmux -L probe`) running a script that logs stdin in raw mode, and drive the page with Chromium's remote debugging. Never type test input into the live tmux server.
