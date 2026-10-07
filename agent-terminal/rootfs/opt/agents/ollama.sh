# shellcheck shell=bash
# Local coding sessions reuse the installed Codex TUI with isolated storage.
AGENT_TITLE="Ollama (local models)"
AGENT_COMMAND="node /opt/agent-terminal/ollama.mjs run"
AGENT_DATA="/data/ollama"
agent_install() {
    if ! command -v codex >/dev/null 2>&1; then
        ( . /opt/agents/codex.sh; agent_install )
    fi
}
agent_env() { echo "AGENT_OLLAMA_DATA=${AGENT_DATA}"; }
agent_run() { exec node /opt/agent-terminal/ollama.mjs run; }
agent_init() {
    ( . /opt/agents/codex.sh; AGENT_DATA=/data/ollama/codex; export CODEX_HOME="${AGENT_DATA}"; agent_init )
}
agent_register_mcp() {
    ( . /opt/agents/codex.sh; export CODEX_HOME=/data/ollama/codex; agent_register_mcp "$@" )
}
agent_login_help() {
    echo '   Choose Ollama in the panel, enter your server URL, and pick an installed local model.'
    echo '   No ChatGPT account or API key is needed. Use /model to switch local models.'
}
