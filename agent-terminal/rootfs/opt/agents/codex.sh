# shellcheck shell=bash
# Agent adapter: OpenAI Codex, with ChatGPT account or API-key login.
# Uses the same adapter contract as claude.sh; no provider-specific changes
# are needed in the terminal, SSH, tmux, or Home Assistant MCP server.

AGENT_TITLE="ChatGPT (OpenAI Codex)"
AGENT_COMMAND="codex"
AGENT_DATA="/data/codex"          # persistent: login, settings, and sessions

# Build time: pin the CLI version verified with this adapter. The npm package
# includes native Linux binaries for both amd64 and aarch64 (including musl).
agent_install() {
    npm install -g @openai/codex@0.154.0
    npm cache clean --force
    codex --version
}

# The loader exports this for boot, ttyd, tmux, and SSH sessions.
agent_env() {
    echo "CODEX_HOME=${AGENT_DATA}"
}

# File-based credentials survive container replacement along with config and
# conversation history. Only seed a new config; preserve existing settings.
agent_init() {
    mkdir -p "${AGENT_DATA}"
    chmod 700 "${AGENT_DATA}"
    if [ ! -e "${AGENT_DATA}/config.toml" ]; then
        (umask 077; printf '%s\n' 'cli_auth_credentials_store = "file"' \
            > "${AGENT_DATA}/config.toml")
    fi
}

# Register missing servers with Codex's own TOML parser/editor. Leave existing
# entries intact: `mcp add` replaces tool filters and enabled/disabled settings.
# Invalid TOML is rejected by both commands without replacing the file.
# Auth lives separately in auth.json. The HA server reads the Supervisor token
# from s6 at runtime; never write that token into the Codex configuration.
agent_register_mcp() {
    local name="$1" cmd="$2"; shift 2
    if codex mcp get "${name}" --json >/dev/null 2>&1; then
        return 0
    fi
    codex mcp add "${name}" -- "${cmd}" "$@"
}

agent_login_help() {
    cat <<'HELP'
   First-time ChatGPT login:
     1. enable device code login in ChatGPT security settings
        (managed workspaces may need an admin to enable it)
     2. in Codex, choose "Sign in with Device Code"
        or from a shell: codex login --device-auth
     3. open the printed URL on your phone or computer,
        sign in to ChatGPT, and enter the one-time code there
     4. from a shell, run: codex
   Check login: codex login status   |   Resume: codex resume
HELP
}
