#!/usr/bin/with-contenv bash
# shellcheck shell=bash
# One-time-per-boot init: the agent's persistent config, sshd, git identity
# and the Home Assistant MCP server. Agent-specific work goes through the
# adapter in /opt/agents (see /usr/local/lib/agent.sh).
set -euo pipefail

OPTIONS="/data/options.json"

# shellcheck source=/usr/local/lib/agent.sh
. /usr/local/lib/agent.sh

echo "[agent-terminal] initialising (agent: ${AGENT} - ${AGENT_TITLE}) ..."

mkdir -p /data/ssh /root/.ssh
chmod 700 /root/.ssh

# ---------------------------------------------------------------------------
# Persistent agent config (this is where the agent's login lives).
# Everything under /data survives add-on restarts AND updates.
# ---------------------------------------------------------------------------
agent_init

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
echo "[agent-terminal] loaded $(grep -c . /root/.ssh/authorized_keys || echo 0) authorized SSH key(s)"

# ---------------------------------------------------------------------------
# sshd config
# ---------------------------------------------------------------------------
SSH_PORT="$(jq -r '.ssh_port // 22222' "${OPTIONS}")"
cat > /etc/ssh/sshd_config <<SSHD
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
SSHD

# ---------------------------------------------------------------------------
# Optional git identity
# ---------------------------------------------------------------------------
GIT_NAME="$(jq -r '.git_user_name // empty' "${OPTIONS}")"
GIT_EMAIL="$(jq -r '.git_user_email // empty' "${OPTIONS}")"
[ -n "${GIT_NAME}" ]  && git config --system user.name  "${GIT_NAME}"  || true
[ -n "${GIT_EMAIL}" ] && git config --system user.email "${GIT_EMAIL}" || true
git config --system --add safe.directory '*' || true

# ---------------------------------------------------------------------------
# Register the built-in Home Assistant MCP server with the agent (idempotent;
# adapters never clobber a config file they can't parse).
# ---------------------------------------------------------------------------
if agent_register_mcp homeassistant node /opt/ha-mcp/server.mjs; then
    echo "[agent-terminal] registered 'homeassistant' MCP server"
else
    echo "[agent-terminal] WARNING: MCP registration failed; agent config left untouched"
fi

# ---------------------------------------------------------------------------
# Login environment for interactive shells (SSH + ttyd)
# ---------------------------------------------------------------------------
{
    echo "# Generated at boot by the add-on; edits are lost on restart."
    echo "export AGENT=${AGENT}"
    agent_env | sed 's/^/export /'
    cat <<'PROFILE'
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
PROFILE
} > /etc/profile.d/agent.sh
# Expose the same to non-login sessions (bare `ssh host <cmd>`, VS Code Remote).
{
    echo "AGENT=${AGENT}"
    agent_env
    if [ -r /run/s6/container_environment/SUPERVISOR_TOKEN ]; then
        echo "SUPERVISOR_TOKEN=$(cat /run/s6/container_environment/SUPERVISOR_TOKEN)"
    fi
} > /root/.ssh/environment
chmod 600 /root/.ssh/environment

{
    printf '\n  ==========================================================\n'
    printf '   %s  -  running on Home Assistant\n' "${AGENT_TITLE}"
    printf '  ==========================================================\n\n'
    printf '   HA config    : /homeassistant   (also reachable as /config)\n'
    printf '   Persistent   : %s\n' "${AGENT_DATA}"
    cat <<'MOTD'
                  login + settings survive restarts AND updates
   Supervisor   : the `ha` CLI works here (ha core restart, ...)
   MCP          : 'homeassistant' server auto-registered
                  (ha_list_entities, ha_call_service, ha_render_template, ...)
   Session      : `agent-session` attaches the shared tmux session
                  (web panel + SSH share it; survives disconnects)

MOTD
    agent_login_help
    echo
} > /etc/motd

echo "[agent-terminal] init complete (ssh port ${SSH_PORT})"
