# Agent Terminal - Home Assistant add-on

Run an AI coding-agent CLI directly on your Home Assistant host.

### [agent-terminal](agent-terminal/)
A persistent terminal for an AI coding agent: sidebar web panel that works on a
phone (drag to scroll, on-screen keys, keyboard-aware layout), SSH for VS Code
Remote-SSH, a shared tmux session that survives disconnects, and a built-in
Home Assistant MCP server.

Choose **Claude Code** or **ChatGPT via OpenAI Codex** in the add-on's `agent`
option. Both use persistent account sign-in and the same Home Assistant tools.
For ChatGPT, select `codex`, restart, and choose **Sign in with Device Code**
in the terminal. See [ChatGPT setup](agent-terminal/DOCS.md#chatgpt-openai-codex).
Agents are pluggable adapters - see
[Adding an agent](agent-terminal/DOCS.md#adding-an-agent).

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
