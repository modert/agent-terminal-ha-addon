# shellcheck shell=bash
# Agent adapter: Anthropic Claude Code.
#
# Every adapter in /opt/agents defines the same three variables and five
# functions - see "Adding an agent" in DOCS.md. Nothing outside this file
# should know anything Claude-specific.

AGENT_TITLE="Claude Code"
AGENT_COMMAND="claude"
AGENT_DATA="/data/claude"          # persistent: login + settings live here

# Build time: install the CLI into the image.
agent_install() {
    npm install -g @anthropic-ai/claude-code
    npm cache clean --force
    claude --version || true
}

# Environment the CLI needs, as NAME=value lines (shell-safe values only).
agent_env() {
    echo "CLAUDE_CONFIG_DIR=${AGENT_DATA}/.claude"
}

# Boot time: point the CLI's config at persistent storage.
agent_init() {
    local cc_json="${AGENT_DATA}/.claude/.claude.json"
    mkdir -p "${AGENT_DATA}/.claude"
    ln -sfn "${AGENT_DATA}/.claude" /root/.claude
    # With CLAUDE_CONFIG_DIR set, Claude Code reads <config-dir>/.claude.json.
    # Point the legacy ~/.claude.json at that same file so both paths agree.
    [ -s "${cc_json}" ] || echo '{}' > "${cc_json}"
    ln -sfn "${cc_json}" /root/.claude.json
}

# agent_register_mcp NAME COMMAND [ARGS...]
# Register a stdio MCP server. Idempotent. Never clobbers a file it can't
# parse - that file also holds the login.
agent_register_mcp() {
    local name="$1" cmd="$2"; shift 2
    local cc_json="${AGENT_DATA}/.claude/.claude.json" args tmp
    jq -e . "${cc_json}" >/dev/null 2>&1 || return 1
    args="$(jq -cn '$ARGS.positional' --args "$@")"
    tmp="$(mktemp)"
    if jq --arg n "${name}" --arg c "${cmd}" --argjson a "${args}" \
          '.mcpServers = (.mcpServers // {})
           | .mcpServers[$n] = {type: "stdio", command: $c, args: $a, env: {}}' \
          "${cc_json}" > "${tmp}" && [ -s "${tmp}" ]; then
        cp -f "${cc_json}" "${cc_json}.bak" 2>/dev/null || true
        mv "${tmp}" "${cc_json}"
    else
        rm -f "${tmp}"
        return 1
    fi
}

# First-run login instructions for the motd.
agent_login_help() {
    cat <<'HELP'
   First-time login (no browser needed on this box):
     1. run:            claude
     2. at the prompt:  /login
     3. choose:         "Claude account with subscription"
     4. open the printed URL on any device, approve,
        copy the code, paste it back here
HELP
}
