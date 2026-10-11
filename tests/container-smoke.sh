#!/usr/bin/env bash
# Run only in a disposable add-on image, never in an installed add-on.
set -euo pipefail
if [ "${AGENT_TERMINAL_TEST_CONTAINER:-}" != "1" ]; then
    echo "This test requires a disposable container with AGENT_TERMINAL_TEST_CONTAINER=1." >&2
    exit 1
fi

codex --version
claude --version
agy --version
grok --version
test -s /opt/webui/index.html

# Exercise a real first boot, importing a different agent than the default.
# The Supervisor request is stubbed; no Home Assistant instance is contacted.
mkdir -p /data /homeassistant /run/s6/container_environment /share/agent-terminal/import
printf '%s' 'agent-terminal-test-supervisor-token' > /run/s6/container_environment/SUPERVISOR_TOKEN
export SUPERVISOR_TOKEN=agent-terminal-test-supervisor-token
cat > /data/options.json <<'JSON'
{"agent":"claude","ssh_port":2202,"web_command":"","mobile_ui":true,"git_user_name":"","git_user_email":"","authorized_keys":[]}
JSON
printf '%s\n' '{"agent":"codex"}' > /share/agent-terminal/import/options.json
curl() { [[ "${*: -1}" == "http://supervisor/addons/self/options" ]]; }
export -f curl
bash /etc/cont-init.d/10-init.sh
unset -f curl
test -f /data/.imported
test ! -e /share/agent-terminal/import
test -s /data/codex/config.toml
# Codex's background app-server cannot stay alive in the container, and the TUI
# aborts when it dies, so the auto-start must be off from the first boot.
grep -qx 'features\.daemon_auto_start = false' /data/codex/config.toml
# An Enter that arrives together with the last key must send the prompt.
grep -qx 'disable_paste_burst = true' /data/codex/config.toml
test -s /data/claude/.claude/.claude.json
# Claude reads files attached in the web terminal without asking first.
jq -e '.permissions.additionalDirectories == ["/data/agent-terminal/uploads"]' \
    /data/claude/.claude/settings.json >/dev/null
test -s /run/agent-terminal/index.html
test "$(bash -lc 'printf %s "$AGENT"')" = codex
test "$(bash -lc 'printf %s "$CODEX_HOME"')" = /data/codex
grep -qx 'CODEX_HOME=/data/codex' /root/.ssh/environment
grep -qx 'CLAUDE_CONFIG_DIR=/data/claude/.claude' /root/.ssh/environment
# Claude Code changes with the image, never by reinstalling itself.
grep -qx 'DISABLE_AUTOUPDATER=1' /root/.ssh/environment
test "$(bash -lc 'printf %s "$DISABLE_AUTOUPDATER"')" = 1
bash -lc 'codex mcp get homeassistant --json' | jq -e '.transport.command == "node"' >/dev/null
# Antigravity keeps everything under the home directory, so its folders are
# links into /data, and it changes with the image like the other CLIs.
test "$(readlink /root/.gemini)" = /data/antigravity/.gemini
test "$(readlink /root/.config/antigravity)" = /data/antigravity/.config/antigravity
grep -qx 'AGY_CLI_DISABLE_AUTO_UPDATE=true' /root/.ssh/environment
jq -e '.["agent-terminal"] | has("PreInvocation") and has("Stop")' /data/antigravity/.gemini/config/hooks.json >/dev/null
# The real CLI reads the server the adapter wrote for it.
bash -lc 'agy mcp list' | grep -Eq '^homeassistant +stdio +enabled +node /opt/ha-mcp/server\.mjs *$'
test "$(bash -lc 'printf %s "$GROK_HOME"')" = /data/grok
grep -qx 'GROK_DISABLE_AUTOUPDATER=1' /root/.ssh/environment
bash -lc 'grok mcp list --json' | jq -e 'any(.[]; .name == "homeassistant" and .command == "node" and .scope == "user")' >/dev/null
jq -e '.hooks | has("SessionStart") and has("Stop")' /data/grok/hooks/agent-terminal.json >/dev/null
sshd -t

# The terminal and SSH share the selected agent's persistent environment.
agent-session --agent shell
tmux has-session -t '=agent-homeassistant-shell'
test "$(tmux show-environment -t '=agent-homeassistant-shell' CODEX_HOME)" = CODEX_HOME=/data/codex
test "$(tmux show-environment -t '=agent-homeassistant-shell' CLAUDE_CONFIG_DIR)" = CLAUDE_CONFIG_DIR=/data/claude/.claude
test "$(tmux show-environment -t '=agent-homeassistant-shell' DISABLE_AUTOUPDATER)" = DISABLE_AUTOUPDATER=1
test "$(tmux show-environment -t '=agent-homeassistant-shell' AGY_CLI_DISABLE_AUTO_UPDATE)" = AGY_CLI_DISABLE_AUTO_UPDATE=true
test "$(tmux show-environment -t '=agent-homeassistant-shell' GROK_HOME)" = GROK_HOME=/data/grok
test "$(tmux show-environment -t '=agent-homeassistant-shell' GROK_DISABLE_AUTOUPDATER)" = GROK_DISABLE_AUTOUPDATER=1
tmux kill-server

# Switch to Claude and back, as a container restart would do. Verify Codex's
# saved data and disabled tool configuration survive both initialization runs.
printf '%s\n' '{"test_credentials":"unchanged"}' > /data/codex/auth.json
mkdir -p /data/codex/sessions
printf '%s\n' 'saved session' > /data/codex/sessions/test.jsonl
cat >> /data/codex/config.toml <<'TOML'
disabled_tools = ["ha_call_service"]
TOML
codex_config_before="$(sha256sum /data/codex/config.toml)"
# Both adapters must preserve the user's MCP configuration on every boot.
jq '.mcpServers.homeassistant = {type:"stdio",command:"custom-ha-server",args:["--read-only"],env:{}}' \
    /data/claude/.claude/.claude.json > /tmp/claude-config-test.json
mv /tmp/claude-config-test.json /data/claude/.claude/.claude.json
claude_config_before="$(sha256sum /data/claude/.claude/.claude.json)"
# So must Claude's settings, once the uploads folder is in them.
jq '.model = "opus" | .permissions.additionalDirectories += ["/share"]' \
    /data/claude/.claude/settings.json > /tmp/claude-settings-test.json
mv /tmp/claude-settings-test.json /data/claude/.claude/settings.json
claude_settings_before="$(sha256sum /data/claude/.claude/settings.json)"
# And Antigravity's servers and hooks, with the user's own beside the add-on's.
jq '.mcpServers.homeassistant = {command:"custom-ha-server",args:["--read-only"],disabledTools:["ha_call_service"]}' \
    /data/antigravity/.gemini/config/mcp_config.json > /tmp/antigravity-servers-test.json
mv /tmp/antigravity-servers-test.json /data/antigravity/.gemini/config/mcp_config.json
jq '.lint = {PostToolUse:[{matcher:"run_command",hooks:[{command:"./lint.sh"}]}]}' \
    /data/antigravity/.gemini/config/hooks.json > /tmp/antigravity-hooks-test.json
mv /tmp/antigravity-hooks-test.json /data/antigravity/.gemini/config/hooks.json
mkdir -p /data/antigravity/.gemini/antigravity-cli
printf '%s' 'test login' > /data/antigravity/.gemini/antigravity-cli/antigravity-oauth-token
antigravity_before="$(sha256sum /data/antigravity/.gemini/config/mcp_config.json /data/antigravity/.gemini/config/hooks.json)"
# Attached files are kept for a week: a boot drops older days, not recent ones.
mkdir -p /data/agent-terminal/uploads/2000-01-01 "/data/agent-terminal/uploads/$(date +%F)"
sed -i 's/"agent": "codex"/"agent": "claude"/' /data/options.json
bash /etc/cont-init.d/10-init.sh
test "$(bash -lc 'printf %s "$AGENT"')" = claude
test -s /data/claude/.claude/.claude.json
sed -i 's/"agent": "claude"/"agent": "codex"/' /data/options.json
bash /etc/cont-init.d/10-init.sh
test "$(bash -lc 'printf %s "$AGENT"')" = codex
test "$(sha256sum /data/codex/config.toml)" = "${codex_config_before}"
test "$(sha256sum /data/claude/.claude/.claude.json)" = "${claude_config_before}"
test "$(sha256sum /data/claude/.claude/settings.json)" = "${claude_settings_before}"
test "$(sha256sum /data/antigravity/.gemini/config/mcp_config.json /data/antigravity/.gemini/config/hooks.json)" = "${antigravity_before}"
test "$(cat /root/.gemini/antigravity-cli/antigravity-oauth-token)" = 'test login'
test ! -e /data/agent-terminal/uploads/2000-01-01
test -d "/data/agent-terminal/uploads/$(date +%F)"
test "$(cat /data/codex/auth.json)" = '{"test_credentials":"unchanged"}'
test "$(cat /data/codex/sessions/test.jsonl)" = 'saved session'
echo 'Container smoke checks passed: imported agent, login environments, tmux, switching, persistence, and uploads.'
