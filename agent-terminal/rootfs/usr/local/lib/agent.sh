# shellcheck shell=bash
# Agent adapter loader - source it, then use AGENT_* and the agent_* functions.
# The agent is $AGENT if set, else the add-on's `agent` option, else claude.

AGENTS_DIR=/opt/agents

# Every terminal can launch either CLI using its persistent login. Keep each
# adapter's definitions in a subshell while collecting their environments.
agent_all_env() {
    local adapter
    for adapter in "${AGENTS_DIR}"/*.sh; do
        ( . "${adapter}"; agent_env )
    done
}

if [ -z "${AGENT:-}" ]; then
    AGENT="$(jq -r '.agent // empty' /data/options.json 2>/dev/null || true)"
fi
AGENT="${AGENT:-claude}"
if [[ ! "${AGENT}" =~ ^[a-z][a-z0-9_-]*$ ]] || [ ! -r "${AGENTS_DIR}/${AGENT}.sh" ]; then
    echo "[agent-terminal] no adapter for agent '${AGENT}'; using claude" >&2
    AGENT=claude
fi
export AGENT

# shellcheck source=/dev/null
. "${AGENTS_DIR}/${AGENT}.sh"

while IFS= read -r _kv; do
    [ -n "${_kv}" ] && export "${_kv}"
done < <(agent_all_env)
unset _kv
