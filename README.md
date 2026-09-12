# Agent Terminal - Home Assistant add-on

Run an AI coding-agent CLI directly on your Home Assistant host.

### [agent-terminal](agent-terminal/)
A persistent terminal for an AI coding agent: sidebar web panel that works on a
phone (drag to scroll, on-screen keys, keyboard-aware layout), SSH for VS Code
Remote-SSH, a shared tmux session that survives disconnects, and a built-in
Home Assistant MCP server.

Claude Code is the only agent wired up so far. Agents are pluggable adapters,
so others (OpenAI Codex, Gemini CLI, ...) can be added without touching the
rest - see [Adding an agent](agent-terminal/DOCS.md#adding-an-agent).

Read [agent-terminal/DOCS.md](agent-terminal/DOCS.md) before installing - it
grants an AI agent root in its container and Supervisor access.

## Install

Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
`https://github.com/modert/agent-terminal-ha-addon`.

## Status

Personal project, shared as-is with no support commitment. Read the source
before installing - it's short enough to actually read.

## License

MIT - see [LICENSE](LICENSE).
