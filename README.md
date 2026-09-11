# Home Assistant Add-ons (personal, unmaintained-in-the-formal-sense)

A small personal repo of Home Assistant add-ons. Shared as-is, no support
commitment - read the source before you install anything from here.

## Add-ons

### [claude-code](claude-code/)
Runs Anthropic's Claude Code CLI on the HA host with a persistent Claude
*account/subscription* login (no API key), a web terminal via Ingress, SSH
(for VS Code Remote-SSH), a shared tmux session, and a built-in Home Assistant
MCP server. See [claude-code/DOCS.md](claude-code/DOCS.md) before installing -
it grants an AI agent root and Supervisor access.

## Install

Settings → Add-ons → Add-on Store → ⋮ → Repositories → add this repo's URL.

## License

MIT - see [LICENSE](LICENSE).
