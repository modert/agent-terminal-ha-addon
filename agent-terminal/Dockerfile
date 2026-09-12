ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV LANG=C.UTF-8 \
    TERM=xterm-256color \
    NODE_OPTIONS=--max-old-space-size=2048 \
    npm_config_update_notifier=false

# Agent CLIs baked into the image: space-separated adapter names from
# rootfs/opt/agents. The add-on's `agent` option picks one at runtime.
ARG AGENTS="claude"

# System deps: node/npm for the agent CLIs, openssh for VS Code Remote-SSH,
# ttyd for the Ingress web terminal, gh for GitHub, plus the usual dev CLIs.
RUN apk add --no-cache \
        nodejs \
        npm \
        git \
        github-cli \
        openssh \
        openssh-client \
        openssh-sftp-server \
        ttyd \
        tmux \
        bash \
        coreutils \
        curl \
        wget \
        jq \
        nano \
        less \
        grep \
        ncurses \
        ripgrep \
        tzdata \
        libstdc++ \
        libgcc \
    && node --version

# Home Assistant CLI (`ha`) - talks to the Supervisor API via $SUPERVISOR_TOKEN,
# so `ha core restart`, `ha core check`, `ha core logs` work from inside here.
RUN set -eu; \
    case "$(uname -m)" in \
        x86_64)  ha_arch=amd64 ;; \
        aarch64) ha_arch=aarch64 ;; \
        armv7l)  ha_arch=armv7 ;; \
        *)       ha_arch=amd64 ;; \
    esac; \
    curl -sSfL -o /usr/bin/ha \
        "https://github.com/home-assistant/cli/releases/latest/download/ha_${ha_arch}"; \
    chmod +x /usr/bin/ha; \
    /usr/bin/ha --version || true

# Agent CLIs. Only the adapters and installer are copied first, so editing the
# rest of rootfs doesn't reinstall them.
COPY rootfs/opt/agents /opt/agents
COPY rootfs/usr/local/bin/agent-install /usr/local/bin/agent-install
RUN chmod +x /usr/local/bin/agent-install \
    && agent-install ${AGENTS} \
    && rm -rf /root/.npm /tmp/*

COPY rootfs /

# Built-in Home Assistant MCP server (structured HA tools for the agent).
RUN cd /opt/ha-mcp \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && node --check server.mjs

# Web terminal UI: one self-contained index.html with xterm.js inlined, served
# by ttyd's --index (which serves that single file and nothing beside it).
# Adds on-screen keys, touch scrolling and keyboard-aware layout for phones.
RUN cd /opt/webui \
    && npm install --no-audit --no-fund \
    && node build.mjs \
    && rm -rf node_modules package-lock.json \
    && npm cache clean --force \
    && test -s index.html

RUN chmod +x /usr/local/bin/agent-session /usr/local/bin/agent-install \
    && ln -sfn agent-session /usr/local/bin/claude-session \
    && find /etc/cont-init.d /etc/services.d -type f -exec chmod a+x {} \;

WORKDIR /homeassistant
