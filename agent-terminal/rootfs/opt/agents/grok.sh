# shellcheck shell=bash
# Agent adapter: xAI's official Grok Build CLI.
AGENT_TITLE="Grok (xAI)"
AGENT_COMMAND="grok"
AGENT_DATA="/data/grok"
GROK_DEFAULT_HOME="/root"

# Pin both architectures to the binaries verified with this adapter. Hashes
# cover the compressed release artifacts from xAI's official distribution.
agent_install() {
    local arch sum tmp
    case "$(uname -m)" in
        x86_64) arch=x86_64; sum=b095e3858a20426b5c90a9afd7101142b4dabc02247bb0d8176c5e334efed9ed ;;
        aarch64) arch=aarch64; sum=15dfe6f0d93001db8cdc0db8153134a1dacbbc46d5907a9d0f45e979d94ca873 ;;
        *) echo "grok: unsupported architecture" >&2; return 1 ;;
    esac
    tmp="$(mktemp -d)"
    curl -fsSL --retry 3 "https://x.ai/cli/grok-1.0.50-linux-${arch}.gz" -o "${tmp}/grok.gz"
    echo "${sum}  ${tmp}/grok.gz" | sha256sum -c -
    gzip -dc "${tmp}/grok.gz" > "${tmp}/grok"
    install -m 755 "${tmp}/grok" /usr/local/bin/grok
    rm -rf "${tmp}"
    grok --version
}

agent_env() {
    echo "GROK_HOME=${AGENT_DATA}"
    echo "GROK_DISABLE_AUTOUPDATER=1"
}

agent_run() {
    local args=()
    [ -z "${AGENT_CONVERSATION_ID:-}" ] || args+=(--resume "${AGENT_CONVERSATION_ID}")
    exec grok "${args[@]}"
}

agent_init() {
    mkdir -p "${AGENT_DATA}/hooks"
    chmod 700 "${AGENT_DATA}"
    # Also cover a shell already running when Grok was hot-deployed: it may
    # not yet have GROK_HOME in its environment. Preserve any early login.
    local link="${GROK_DEFAULT_HOME}/.grok"
    if [ -d "${link}" ] && [ ! -L "${link}" ]; then
        cp -an "${link}/." "${AGENT_DATA}/" && rm -rf "${link}"
    fi
    ln -sfn "${AGENT_DATA}" "${link}"
    # This file belongs to the add-on; other hooks and config remain untouched.
    local tmp
    tmp="$(mktemp)"
    jq -n '{hooks: {
        SessionStart: [{hooks: [{type: "command", timeout: 5,
            command: "node /opt/agent-terminal/session-hook.mjs grok SessionStart"}]}],
        Stop: [{hooks: [{type: "command", timeout: 5,
            command: "node /opt/agent-terminal/session-hook.mjs grok Stop"}]}]
    }}' > "${tmp}"
    if cmp -s "${tmp}" "${AGENT_DATA}/hooks/agent-terminal.json"; then
        rm -f "${tmp}"
    else
        mv "${tmp}" "${AGENT_DATA}/hooks/agent-terminal.json"
    fi
}

agent_register_mcp() {
    local name="$1" cmd="$2" servers; shift 2
    # Use the CLI's TOML parser/editor, and keep any existing user entry,
    # including disabled tools or a deliberately disabled server.
    servers="$(GROK_HOME="${AGENT_DATA}" grok mcp list --json)" || return 1
    jq -e 'type == "array"' <<< "${servers}" >/dev/null || return 1
    if jq -e --arg n "${name}" 'any(.[]; .name == $n and .scope == "user")' <<< "${servers}" >/dev/null; then
        return 0
    fi
    GROK_HOME="${AGENT_DATA}" grok mcp add --scope user "${name}" -- "${cmd}" "$@"
}

agent_login_help() {
    cat <<'HELP'
   First-time Grok login (no browser needed on this box):
     1. from a Shell session, run: grok login --device-auth
     2. open the printed URL on your phone or computer and enter its code
     3. select Grok in the panel
   With an xAI API key instead: see "Grok (xAI)" in the add-on docs.
HELP
}
