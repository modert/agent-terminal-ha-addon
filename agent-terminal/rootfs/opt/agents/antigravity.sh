# shellcheck shell=bash
# Agent adapter: Google Antigravity CLI (`agy`), with Google account or Gemini
# API-key login. Uses the same adapter contract as claude.sh.

AGENT_TITLE="Antigravity (Google)"
AGENT_COMMAND="agy"
AGENT_DATA="/data/antigravity"     # persistent: login, settings, and conversations

# The CLI has no setting for where it keeps its files: everything goes under
# the home directory, so those folders are links into AGENT_DATA.
ANTIGRAVITY_HOME="/root"

# Build time: the current release for this architecture, checked against the
# checksum its manifest publishes. This is what the official installer
# (https://antigravity.google/cli/install.sh) does, without its last step,
# which runs the new binary to edit shell profiles.
agent_install() {
    local base="https://antigravity-cli-auto-updater-974169037036.us-central1.run.app"
    local arch manifest url sum tmp
    case "$(uname -m)" in
        x86_64)  arch=amd64 ;;
        aarch64) arch=arm64 ;;
        *) echo "antigravity: no build for $(uname -m)" >&2; return 1 ;;
    esac
    manifest="$(curl -fsSL "${base}/manifests/linux_${arch}_musl.json")"
    url="$(jq -er '.url' <<< "${manifest}")"
    sum="$(jq -er '.sha512' <<< "${manifest}")"
    tmp="$(mktemp -d)"
    curl -fsSL -o "${tmp}/agy.tar.gz" "${url}"
    echo "${sum}  ${tmp}/agy.tar.gz" | sha512sum -c -
    tar -xzf "${tmp}/agy.tar.gz" -C "${tmp}" antigravity
    install -m 755 "${tmp}/antigravity" /usr/local/bin/agy
    rm -rf "${tmp}"
    # Home Assistant builds this image on the machine that runs it, and the
    # binary stops at once on a processor without the instructions it was
    # compiled for. That must not fail the build: the other agents still work
    # there, and agent_run explains it to whoever opens an Antigravity session.
    agy --version || echo "antigravity: installed, but it cannot run on this processor" >&2
}

agent_env() {
    # The image supplies the CLI. Left on, it replaces its own binary in the
    # background, and the container forgets that at the next restart.
    echo "AGY_CLI_DISABLE_AUTO_UPDATE=true"
}

agent_run() {
    local args=() reason
    # The binary ends its last words with a NUL, which a variable cannot hold.
    if ! reason="$(agy --version 2>&1 | tr -d '\0'; exit "${PIPESTATUS[0]}")"; then
        antigravity_cannot_start "${reason}"
        return 1
    fi
    # An ID whose conversation is gone starts a new one, with a warning.
    [ -z "${AGENT_CONVERSATION_ID:-}" ] || args+=(--conversation "${AGENT_CONVERSATION_ID}")
    exec agy "${args[@]}"
}

# The pane closes when this returns, so keep the reason on screen until it has
# been read. Returning an error then stops the session instead of letting the
# web terminal start the same failure again on every reconnect.
antigravity_cannot_start() {
    printf '\n  Antigravity cannot start on this machine.\n\n'
    printf '%s\n' "$1" | sed 's/^/    /'
    case "$1" in
        *processor*)
            cat <<'HELP'

  Its program needs processor instructions this machine does not offer. In a
  virtual machine that is usually the CPU type: a generic model, the default
  in QEMU and Proxmox, hides them from the guest. Set the virtual machine's
  CPU type to "host", restart it, then choose Start in Sessions.
HELP
            ;;
    esac
    printf '\n  Press Enter to close this session. '
    read -r _ || true
}

# Boot time: keep the CLI's folders in persistent storage. Without a desktop
# keyring it stores the login in files there too.
agent_init() {
    mkdir -p "${AGENT_DATA}" "${ANTIGRAVITY_HOME}/.config"
    chmod 700 "${AGENT_DATA}"
    antigravity_persist .gemini
    antigravity_persist .config/antigravity
    mkdir -p "${AGENT_DATA}/.gemini/config"
    antigravity_session_hooks
}

# Move anything a CLI started before boot left behind, then link the folder.
antigravity_persist() {
    local link="${ANTIGRAVITY_HOME}/$1" target="${AGENT_DATA}/$1"
    mkdir -p "${target}"
    if [ -d "${link}" ] && [ ! -L "${link}" ]; then
        cp -an "${link}/." "${target}/" && rm -rf "${link}"
    fi
    ln -sfn "${target}" "${link}"
}

# Antigravity names the conversation in use each time it calls the model. A
# named session saves that, to open the same conversation after a restart.
# The entry is the add-on's own, so it follows the image; every other hook in
# the file is kept, and a file that doesn't parse is never rewritten.
antigravity_session_hooks() {
    local hooks="${AGENT_DATA}/.gemini/config/hooks.json" tmp
    [ -s "${hooks}" ] || echo '{}' > "${hooks}"
    jq -e 'type == "object"' "${hooks}" >/dev/null 2>&1 || return 0
    tmp="$(mktemp)"
    if jq '."agent-terminal" = {
               PreInvocation: [{type: "command", timeout: 5,
                   command: "node /opt/agent-terminal/session-hook.mjs antigravity PreInvocation"}],
               Stop: [{type: "command", timeout: 5,
                   command: "node /opt/agent-terminal/session-hook.mjs antigravity Stop"}]}' \
          "${hooks}" > "${tmp}" 2>/dev/null && [ -s "${tmp}" ] && \
       ! jq -e --slurpfile new "${tmp}" '. == $new[0]' "${hooks}" >/dev/null 2>&1; then
        chmod --reference="${hooks}" "${tmp}" 2>/dev/null || true
        mv "${tmp}" "${hooks}"
    else
        rm -f "${tmp}"
    fi
}

# agent_register_mcp NAME COMMAND [ARGS...]
# Written directly, because `agy mcp add` replaces a server that is already
# there, and with it the user's own command or disabled tools. It also keeps
# boot from depending on a binary that some processors cannot run.
agent_register_mcp() {
    local name="$1" cmd="$2"; shift 2
    local config="${AGENT_DATA}/.gemini/config/mcp_config.json" args tmp
    [ -s "${config}" ] || echo '{}' > "${config}"
    jq -e 'type == "object"' "${config}" >/dev/null 2>&1 || return 1
    if jq -e --arg n "${name}" '(.mcpServers // {}) | has($n)' "${config}" >/dev/null 2>&1; then
        return 0
    fi
    args="$(jq -cn '$ARGS.positional' --args "$@")"
    tmp="$(mktemp)"
    if jq --arg n "${name}" --arg c "${cmd}" --argjson a "${args}" \
          '.mcpServers = (.mcpServers // {}) | .mcpServers[$n] = {command: $c, args: $a}' \
          "${config}" > "${tmp}" 2>/dev/null && [ -s "${tmp}" ]; then
        chmod --reference="${config}" "${tmp}" 2>/dev/null || true
        mv "${tmp}" "${config}"
    else
        rm -f "${tmp}"
        return 1
    fi
}

agent_login_help() {
    cat <<'HELP'
   First-time Antigravity login (no browser needed on this box):
     1. run:     agy
     2. choose:  "Google OAuth"
     3. open the printed URL on any device, sign in to Google,
        copy the authorization code, paste it back here
   With a Gemini API key instead: see "Antigravity" in the add-on docs.
HELP
}
