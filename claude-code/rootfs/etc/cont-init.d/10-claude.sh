#!/usr/bin/with-contenv bash
# shellcheck shell=bash
# One-time-per-boot init: wire up persistent Claude config + sshd.
set -euo pipefail

OPTIONS="/data/options.json"
CLAUDE_DATA="/data/claude"

echo "[claude-code] initialising ..."

mkdir -p "${CLAUDE_DATA}/.claude" /data/ssh /root/.ssh
chmod 700 /root/.ssh

# ---------------------------------------------------------------------------
# Persistent Claude config  (this is where the Claude-account login lives).
# Everything under /data survives add-on restarts AND updates.
# ---------------------------------------------------------------------------
ln -sfn "${CLAUDE_DATA}/.claude" /root/.claude
# With CLAUDE_CONFIG_DIR set, Claude Code reads <config-dir>/.claude.json.
# Point the legacy ~/.claude.json at that same file so both paths agree.
CC_JSON="${CLAUDE_DATA}/.claude/.claude.json"
[ -e "${CC_JSON}" ] || echo '{}' > "${CC_JSON}"
ln -sfn "${CC_JSON}" /root/.claude.json

# Convenience: keep the familiar /config path pointing at the HA config dir.
if [ -d /homeassistant ] && [ ! -e /config ]; then
    ln -sfn /homeassistant /config
fi

# ---------------------------------------------------------------------------
# Persistent SSH host keys (so VS Code doesn't scream after every rebuild).
# ---------------------------------------------------------------------------
for t in ed25519 rsa ecdsa; do
    key="/data/ssh/ssh_host_${t}_key"
    [ -f "${key}" ] || ssh-keygen -q -t "${t}" -N "" -f "${key}"
done

# ---------------------------------------------------------------------------
# authorized_keys from add-on options
# ---------------------------------------------------------------------------
: > /root/.ssh/authorized_keys
jq -r '.authorized_keys[]? // empty' "${OPTIONS}" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "[claude-code] loaded $(grep -c . /root/.ssh/authorized_keys || echo 0) authorized SSH key(s)"

# ---------------------------------------------------------------------------
# sshd config
# ---------------------------------------------------------------------------
SSH_PORT="$(jq -r '.ssh_port // 22222' "${OPTIONS}")"
cat > /etc/ssh/sshd_config <<EOF
Port ${SSH_PORT}
AddressFamily any
ListenAddress 0.0.0.0
HostKey /data/ssh/ssh_host_ed25519_key
HostKey /data/ssh/ssh_host_rsa_key
HostKey /data/ssh/ssh_host_ecdsa_key
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile /root/.ssh/authorized_keys
Subsystem sftp internal-sftp
AllowTcpForwarding yes
AllowAgentForwarding yes
PermitTunnel yes
GatewayPorts yes
X11Forwarding no
PermitUserEnvironment yes
PrintMotd yes
ClientAliveInterval 120
ClientAliveCountMax 3
AcceptEnv LANG LC_* TERM COLORTERM
EOF

# ---------------------------------------------------------------------------
# Optional git identity
# ---------------------------------------------------------------------------
GIT_NAME="$(jq -r '.git_user_name // empty' "${OPTIONS}")"
GIT_EMAIL="$(jq -r '.git_user_email // empty' "${OPTIONS}")"
[ -n "${GIT_NAME}" ]  && git config --system user.name  "${GIT_NAME}"  || true
[ -n "${GIT_EMAIL}" ] && git config --system user.email "${GIT_EMAIL}" || true
git config --system --add safe.directory '*' || true

# ---------------------------------------------------------------------------
# Register the built-in Home Assistant MCP server (user scope, idempotent).
# Never clobber a non-empty file we can't parse - that would nuke the login.
# ---------------------------------------------------------------------------
if [ ! -s "${CC_JSON}" ]; then echo '{}' > "${CC_JSON}"; fi
if jq -e . "${CC_JSON}" >/dev/null 2>&1; then
    mcp_tmp="$(mktemp)"
    if jq '.mcpServers = (.mcpServers // {})
           | .mcpServers.homeassistant = {
               "type": "stdio",
               "command": "node",
               "args": ["/opt/ha-mcp/server.mjs"],
               "env": {}
             }' "${CC_JSON}" > "${mcp_tmp}" && [ -s "${mcp_tmp}" ]; then
        cp -f "${CC_JSON}" "${CC_JSON}.bak" 2>/dev/null || true
        mv "${mcp_tmp}" "${CC_JSON}"
        echo "[claude-code] registered 'homeassistant' MCP server"
    else
        rm -f "${mcp_tmp}"
        echo "[claude-code] WARNING: MCP register failed; left .claude.json untouched"
    fi
else
    echo "[claude-code] WARNING: ${CC_JSON} not valid JSON; skipped MCP registration"
fi

# ---------------------------------------------------------------------------
# Login environment for interactive shells (SSH + ttyd)
# ---------------------------------------------------------------------------
cat > /etc/profile.d/claude.sh <<'EOF'
export CLAUDE_CONFIG_DIR=/data/claude/.claude
export EDITOR="${EDITOR:-nano}"
# Supervisor token -> lets `ha` and `curl http://supervisor/core/api/...` work.
if [ -z "${SUPERVISOR_TOKEN:-}" ] && [ -r /run/s6/container_environment/SUPERVISOR_TOKEN ]; then
    export SUPERVISOR_TOKEN="$(cat /run/s6/container_environment/SUPERVISOR_TOKEN)"
fi
alias hass-api='curl -s -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" http://supervisor/core/api'
if [ -n "${PS1:-}" ]; then
    alias ll='ls -la'
    [ -d /homeassistant ] && cd /homeassistant
fi
EOF
# Expose the same to non-login sessions (bare `ssh host claude ...`, VS Code Remote).
{
    echo "CLAUDE_CONFIG_DIR=/data/claude/.claude"
    [ -r /run/s6/container_environment/SUPERVISOR_TOKEN ] && \
        echo "SUPERVISOR_TOKEN=$(cat /run/s6/container_environment/SUPERVISOR_TOKEN)"
} > /root/.ssh/environment
chmod 600 /root/.ssh/environment

cat > /etc/motd <<'EOF'

  ==========================================================
   Claude Code  -  running on Home Assistant
  ==========================================================

   HA config    : /homeassistant   (also reachable as /config)
   Persistent   : /data/claude/.claude
                  login + settings survive restarts AND updates
   Supervisor   : the `ha` CLI works here (ha core restart, ...)
   MCP          : 'homeassistant' server auto-registered
                  (ha_list_entities, ha_call_service, ha_render_template, ...)
   Session      : `claude-session` attaches the shared tmux session
                  (web panel + SSH share it; survives disconnects)

   First-time login (no browser needed on this box):
     1. run:            claude
     2. at the prompt:  /login
     3. choose:         "Claude account with subscription"
     4. open the printed URL on any device, approve,
        copy the code, paste it back here

EOF

echo "[claude-code] init complete (ssh port ${SSH_PORT})"
