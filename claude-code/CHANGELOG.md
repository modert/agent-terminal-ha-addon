# Changelog

## 1.1.1
- Fix: with `CLAUDE_CONFIG_DIR` set, Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json`,
  not `~/.claude.json` - MCP registration now targets the right file, non-destructively.

## 1.1.0
- Add persistent tmux session (`claude-session`) shared between the Ingress panel
  and SSH; survives disconnects.
- Add a built-in `homeassistant` MCP server (`/opt/ha-mcp`) with entity/service/
  template tools over the Supervisor API.

## 1.0.0
- Initial release: Claude Code CLI with persistent Claude-account (subscription)
  login, Ingress web terminal (ttyd), and SSH (VS Code Remote-SSH support).
