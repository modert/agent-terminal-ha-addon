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
    npm install -g @openai/codex@0.159.2
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
            'features.daemon_auto_start = false' \
            > "${AGENT_DATA}/config.toml")
    fi
    codex_disable_daemon_auto_start
}

# 0.157 runs the agent inside a background app-server by default. That server
# dies here before Codex can record its start time, so the TUI exits with
# "failed to record pid-managed app-server process ... startup" and the web
# terminal shows an endless reload. Codex works normally without it, so switch
# the auto-start off in the stored config once: that covers the panel, tmux,
# and a bare `codex` typed over SSH. Leave the setting alone once it is there,
# including a deliberate `true`.
codex_disable_daemon_auto_start() {
    local config="${AGENT_DATA}/config.toml"
    if grep -q '^[[:space:]]*\(features\.\)\?daemon_auto_start[[:space:]]*=' "${config}"; then
        return 0
    fi
    if grep -q '^[[:space:]]*\[features\]' "${config}"; then
        # A dotted key cannot reopen a table the file already declares, and a
        # second [features] header is invalid TOML: extend the existing table.
        sed -i '/^[[:space:]]*\[features\]/a daemon_auto_start = false' "${config}"
    else
        # First line, as a dotted key, so it belongs to no table and the end of
        # the file stays free for whatever appends a plain top-level setting.
        sed -i '1i features.daemon_auto_start = false' "${config}"
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
