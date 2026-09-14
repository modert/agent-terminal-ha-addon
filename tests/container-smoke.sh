#!/usr/bin/env bash
# Run only in a disposable add-on image, never in an installed add-on.
set -euo pipefail
if [ "${AGENT_TERMINAL_TEST_CONTAINER:-}" != "1" ]; then
    echo "This test requires a disposable container with AGENT_TERMINAL_TEST_CONTAINER=1." >&2
    exit 1
fi

codex --version
claude --version
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
test "$(bash -lc 'printf %s "$AGENT"')" = codex
test "$(bash -lc 'printf %s "$CODEX_HOME"')" = /data/codex
grep -qx 'CODEX_HOME=/data/codex' /root/.ssh/environment
bash -lc 'codex mcp get homeassistant --json' | jq -e '.transport.command == "node"' >/dev/null
sshd -t

# The terminal and SSH share the selected agent's persistent environment.
agent-session 'bash -l'
tmux has-session -t agent
test "$(tmux show-environment -g CODEX_HOME)" = CODEX_HOME=/data/codex
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
sed -i 's/"agent": "codex"/"agent": "claude"/' /data/options.json
bash /etc/cont-init.d/10-init.sh
test "$(bash -lc 'printf %s "$AGENT"')" = claude
test -s /data/claude/.claude/.claude.json
sed -i 's/"agent": "claude"/"agent": "codex"/' /data/options.json
bash /etc/cont-init.d/10-init.sh
test "$(bash -lc 'printf %s "$AGENT"')" = codex
test "$(sha256sum /data/codex/config.toml)" = "${codex_config_before}"
test "$(cat /data/codex/auth.json)" = '{"test_credentials":"unchanged"}'
test "$(cat /data/codex/sessions/test.jsonl)" = 'saved session'
echo 'Container smoke checks passed: imported agent, login environments, tmux, switching, and persistence.'
