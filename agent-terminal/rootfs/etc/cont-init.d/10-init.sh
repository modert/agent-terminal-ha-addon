#!/usr/bin/with-contenv bash
# shellcheck shell=bash
# One-time-per-boot init: the agent's persistent config, sshd, git identity
# and the Home Assistant MCP server. Agent-specific work goes through the
# adapter in /opt/agents (see /usr/local/lib/agent.sh).
set -euo pipefail

OPTIONS="/data/options.json"

# ---------------------------------------------------------------------------
# One-time import (e.g. moving from the old claude_code slug, whose /data
# Home Assistant keeps separate). Copies agent data + SSH host keys without
# overwriting anything, applies the saved options, then deletes the import
# folder so credentials don't linger in /share.
# ---------------------------------------------------------------------------
IMPORT_DIR="/share/agent-terminal/import"
if [ -d "${IMPORT_DIR}" ] && [ ! -e /data/.imported ]; then
    echo "[agent-terminal] importing from ${IMPORT_DIR} ..."
    for src in "${IMPORT_DIR}"/*/; do
        [ -d "${src}" ] || continue
        name="$(basename "${src}")"
        if [ -e "/data/${name}" ]; then
            echo "[agent-terminal]   /data/${name} already exists - skipped"
        else
            cp -a "${src%/}" "/data/${name}"
            echo "[agent-terminal]   imported /data/${name}"
        fi
    done
    if [ -s "${IMPORT_DIR}/options.json" ]; then
        # Only carry over keys this add-on's schema knows (they're all present
        # in the current options.json, which Supervisor fills with defaults).
        merged="$(jq -s '.[0] as $cur
                         | $cur + (.[1] | with_entries(select(.key as $k | $cur | has($k))))' \
                  "${OPTIONS}" "${IMPORT_DIR}/options.json")"
        if curl -sf -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
                -H "Content-Type: application/json" \
                -d "$(jq -n --argjson o "${merged}" '{options: $o}')" \
                http://supervisor/addons/self/options >/dev/null; then
            printf '%s\n' "${merged}" > "${OPTIONS}"
            echo "[agent-terminal]   applied imported options"
        else
            cp -f "${IMPORT_DIR}/options.json" /data/imported-options.json
            echo "[agent-terminal]   WARNING: could not apply options; copy kept at /data/imported-options.json"
        fi
    fi
    touch /data/.imported
    rm -rf "${IMPORT_DIR}"
    rmdir /share/agent-terminal 2>/dev/null || true
fi

# Import may have changed the selected agent. Resolve it only after applying
# the imported options so persistence, MCP, and login environments all agree.
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
# GitHub CLI: keep `gh auth login` across restarts (its config lives in
# /data/gh) and let git push/pull over HTTPS with that login.
# ---------------------------------------------------------------------------
mkdir -p /data/gh /root/.config
if [ -d /root/.config/gh ] && [ ! -L /root/.config/gh ]; then
    cp -an /root/.config/gh/. /data/gh/ && rm -rf /root/.config/gh
fi
chmod 700 /data/gh             # after the copy - cp -a carries the source dir's mode
ln -sfn /data/gh /root/.config/gh
if command -v gh >/dev/null 2>&1; then
    git config --system --unset-all credential.https://github.com.helper || true
    git config --system --add credential.https://github.com.helper ''
    git config --system --add credential.https://github.com.helper '!gh auth git-credential'
fi

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
