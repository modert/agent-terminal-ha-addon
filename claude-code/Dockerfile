ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV LANG=C.UTF-8 \
    TERM=xterm-256color \
    CLAUDE_CONFIG_DIR=/data/claude/.claude \
    NODE_OPTIONS=--max-old-space-size=2048 \
    npm_config_update_notifier=false

# System deps: node/npm for Claude Code, openssh for VS Code Remote-SSH,
# ttyd for the Ingress web terminal, plus the usual dev CLIs.
RUN apk add --no-cache \
        nodejs \
        npm \
        git \
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
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/* \
    && node --version \
    && claude --version || true

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

COPY rootfs /

# Built-in Home Assistant MCP server (structured HA tools for Claude).
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

RUN chmod +x /usr/local/bin/claude-session \
    && find /etc/cont-init.d /etc/services.d -type f -exec chmod a+x {} \;

WORKDIR /homeassistant
