# Agent Terminal

Runs an AI coding-agent CLI directly on your Home Assistant host, in a
persistent terminal you can reach from the sidebar (including on a phone) or
over SSH.

Supported agents:

| `agent` | CLI | Login |
|---|---|---|
| `claude` | Anthropic's [Claude Code](https://github.com/anthropics/claude-code) | Your normal Claude account (subscription) - no API key |
| `codex` | [OpenAI Codex](https://developers.openai.com/codex/cli/) (ChatGPT) | ChatGPT account with Codex access, using device code sign-in; API key also supported |
| `ollama` | Codex terminal connected to your local Ollama server | No ChatGPT account or API key; select an installed local model |

The add-on is built around per-agent adapters, so more can be added - see
[Adding an agent](#adding-an-agent).

## ⚠️ Before you install

This add-on gives an AI coding agent **root inside a container with:**
- read/write access to your Home Assistant config, add-ons, share, backups, and media
- the Supervisor API (`hassio_role: manager` - can restart Core, manage add-ons, etc.)
- optionally, SSH into that container from the network

Only install this if you understand and accept that. Set `authorized_keys`
carefully, keep `ssh_port` off any port-forwarded range, and don't hand this
add-on's SSH access to anyone you wouldn't hand root on your HA box to.

## Setup

1. **Configuration tab**: choose the initial agent, `agent: claude`, `agent: codex`, or `agent: ollama`. Add your SSH
   public key(s) to `authorized_keys` if you want SSH access, or leave it empty
   to use the web panel only. Leave `web_command` empty to launch the selected
   agent.
2. **Start** the add-on.
3. Open the **Agent Terminal** panel in the sidebar (or SSH to `<ha-host>:<ssh_port>`
   as `root`).
4. Sign in using the instructions for your selected agent below.

### Claude Code

First run:

```
claude
/login
```

Choose **"Claude account with subscription"**, open the printed URL on any
device, approve, copy the code, paste it back. No browser needed on the HA
host itself. This only has to be done once - the login persists across
add-on restarts and updates.

### ChatGPT (OpenAI Codex)

1. Open the sidebar panel and click **ChatGPT** (or press **Ctrl+Shift+2**).
   It launches Codex without restarting the add-on.
2. Enable **device code login** in your ChatGPT security settings. For a
   managed workspace, an admin may need to enable it.
3. Choose **Sign in with Device Code** in Codex. Open the displayed URL on
   your phone or computer, sign in to ChatGPT, and enter the code **in that
   browser**. No browser or localhost callback is needed on the HA host.
4. Complete Codex's workspace trust prompts for `/homeassistant`. Use `/mcp`
   to check the `homeassistant` tools and `/model` to choose among the models
   your account can use.

From an SSH shell or the panel's **Shell** button, the equivalent
commands are:

```sh
codex login --device-auth
codex login status
codex
```

This runs OpenAI's Codex terminal agent using your ChatGPT account. ChatGPT
sign-in requires account access to Codex and is subject to that account's
usage limits. The add-on does not import chats or memory from the ChatGPT
website. See [OpenAI's authentication documentation](https://developers.openai.com/codex/auth/)
for sign-in requirements and device code troubleshooting.

Codex can also use an OpenAI API key with separate API billing. To enter a key
from a shell without putting it in command history:

```sh
read -rsp 'OpenAI API key: ' codex_api_key; printf '\n'
printf '%s' "$codex_api_key" | codex login --with-api-key
unset codex_api_key
```

Every terminal sets `CODEX_HOME=/data/codex`. Credentials (`auth.json`),
settings (`config.toml`), and saved sessions stay there across updates. A new
config uses file-based credential storage; existing settings are preserved.
Start-up adds `disable_paste_burst = true` when the setting is missing.
Without it Codex treats keys that arrive close together as a paste and an
Enter right after them as a line break, so a prompt sent in one motion stays
in the composer. Real pastes are unaffected. A Codex already running picks
the setting up when it is restarted; set it to `false` to keep Codex's default.
The terminal automatically resumes its saved conversation after restarting.
Use `/resume` inside Codex to select an older conversation explicitly. Click
**Claude** to return to Claude's live session with its own login intact.

The built-in MCP server uses the add-on's Supervisor token at runtime; no HA
token or API key needs to be copied into Codex's config. An existing
`homeassistant` MCP entry is kept as configured, including disabled tools or
an explicitly disabled server. Codex's normal
approval and sandbox settings apply. Start with a read-only request such as
"List my Home Assistant lights and their current state using the homeassistant
tools."

### Local Ollama sessions

Choose **Ollama** in the top bar or create a named session with provider
**Ollama**. Enter your server URL if it is not already configured. The first
connection uses your Health review server/model as its starting selection.
Pick an installed model by number or name, or press Enter for the saved
selection. Type `s` at the picker to change servers. A failed connection
offers retry or quit; quitting stops that session until you choose Start.

Use Ollama 0.13.3 or newer, which provides the Responses API. This is an
interactive coding session: the existing Codex terminal connects
to Ollama for inference and can read files, edit code, run commands, and use
the Home Assistant MCP tools. No ChatGPT account or API key is needed. Only
installed local models advertising completion and tool support are listed;
cloud-backed models are excluded and models are never downloaded. The local
model catalog also supplies the terminal's **/model** picker. Models with
vision support can use attached images. Thinking starts off; supported models
can enable it through the model picker.

Local Codex settings and transcripts live in `/data/ollama/codex`, separately
from ChatGPT's `/data/codex`. Startup server/model selections are remembered
per terminal under `/data/agent-terminal/ollama`. Named local conversations
resume after Stop/Start and updates, and work in split view. File operations
use the local session's permission settings. Configure at least a 64K context
window on the Ollama server for coding, as described in
[Ollama's Codex guide](https://docs.ollama.com/integrations/codex). Response
quality and speed depend on your model and hardware.

From SSH, open the same general local session with:

```sh
agent-session --agent ollama --workspace homeassistant
```

## What you get

- **Persistent login** - stored under `/data`, survives restarts/updates.
- **Two ways in** - the sidebar Ingress panel, and SSH (for VS Code Remote-SSH,
  full IDE experience against `/homeassistant`).
- **Live agent switching and task workspaces** - each workspace/agent pair has
  a separate tmux session. The panel and SSH can attach to the same pair, so a
  long-running task keeps going if you close the browser tab or your SSH
  connection drops.
- **Files and images for the agent** - paste a screenshot, drop a file, or
  pick a photo on your phone, and it lands in the prompt (see
  [Attaching files and images](#attaching-files-and-images-sidebar-panel)).
- **Optional health alerts** - monitor new Home Assistant errors and important
  entities, choose a reviewer, and receive major-issue prompts on your phone
  (see [Health monitoring and alerts](#health-monitoring-and-alerts)).
- **Built-in `homeassistant` MCP server** - gives the agent structured tools
  instead of hand-rolled `curl`: `ha_list_entities`, `ha_get_entity_state`,
  `ha_call_service`, `ha_render_template`, `ha_list_services`,
  `ha_get_error_log`. No token to configure - it uses the add-on's own
  Supervisor token.
- **GitHub CLI (`gh`)** - run `gh auth login` once; the login is kept in
  `/data/gh`, and git uses it for HTTPS pushes/pulls to GitHub.
- **`ha` CLI** on PATH for Supervisor-level operations (`ha core restart`, etc.).

## Switching agents and workspaces

### Codex from the ChatGPT phone app

Open **Sessions → Phone remote → Enable Remote**. Once the status says
**Connected**, choose **Pair a phone**. In the ChatGPT phone app, open Codex
or Remote, add a connection, and enter the displayed code using the same
ChatGPT account and workspace. Codes expire in about ten minutes; generate
a fresh one when you are ready to connect. Your account and app must offer
the manual pairing flow. Native Remote is experimental; OpenAI's general
[Remote setup guide](https://learn.chatgpt.com/docs/remote-connections)
documents desktop hosts, while the add-on uses Codex's native Remote protocol.

Remote uses your existing Codex ChatGPT login. API-key-only login cannot
register a Remote host. The shared server runs tasks inside the add-on with
its existing Home Assistant tools, permissions, and sandbox settings. Its
local transports are private Unix sockets in Codex's reserved socket
directory; the phone connects through OpenAI's authenticated relay. No
additional port forwarding or API key is needed.

The enabled setting is stored in `/data/agent-terminal/remote.json`. The
service reconnects after a server failure and starts again after an add-on
boot when enabled. **Disable Remote** disconnects phone access and ends tasks
on the Remote server. Existing ordinary Claude, ChatGPT, and Shell terminal
tasks keep their independent processes.

To use the same server from Agent Terminal, open **Shell** and run:

```sh
agent-remote open                         # start a conversation on the shared server
agent-remote open CONVERSATION_ID         # join an exact saved conversation
```

New shared-server conversations are available to paired phones. Opening the
same shared conversation from a phone or terminal attaches to that server's
running work. Existing ordinary ChatGPT terminals are independent; opening
their saved history through Remote does not take control of their running
process. Finish or stop that terminal before resuming its history remotely.

Shell commands `agent-remote status`, `start`, `pair`, and `stop` provide the
same controls. Pairing codes are only returned to the requesting browser or
shell, and are never stored in status snapshots or settings. Read
`/run/agent-terminal/remote-status.json` to diagnose the current connection.

The top bar is available on desktop and phones. Choose **Claude**, **ChatGPT**,
**Ollama**, or **Shell**. **Ctrl+Shift+1** opens Claude, **Ctrl+Shift+2** opens
ChatGPT, and **Ctrl+Shift+3** opens Shell. Use the buttons if your browser or OS reserves
a shortcut. The workspace selector chooses the task folder. The keyboard
button at the right end shows or hides the on-screen helper keys (see
[Helper keys on a desktop](#helper-keys-on-a-desktop)). The **⌃** button
next to it collapses the bar to a slim strip naming the current agent and
workspace. Tap or click the strip to bring the bar back. The shortcuts keep
working while it is collapsed, and each device remembers the choice.

Switching detaches the current terminal and attaches the selected session.
An agent keeps working while you are viewing another one. Returning to the
same workspace and agent reconnects to that live process, including its
conversation. Conversations are separate; switching does not transfer chat
history between providers. Sign in to each provider once.

You can type as soon as you have picked a session. Keys pressed while it is
still connecting are kept and typed into it, in order, once it is on screen.
After a disconnect of more than ten seconds they are dropped instead, and the
page says so.

### Named sessions and split view

Open **Sessions** (or **Ctrl+Shift+K**, **⌘Shift+K** on a Mac), then **+ New session**.
Give the session a task name and optional short purpose, choose its provider and workspace, and click
**Create session**. You can run several ChatGPT or Claude sessions in the same
workspace with separate conversations. They share that workspace's files and
the provider's saved login. The existing provider buttons return to each
provider's original session, shown as **General session** in the picker until
you rename it; existing running sessions are preserved.

The picker groups tasks by workspace, with a provider icon and label on each
row. **Current**, **Left pane**, and **Right pane** show where a session is
visible. Search by task name, purpose, provider, or workspace; arrow keys and
Enter choose a result. Unused default sessions are hidden until you choose
**Show unused sessions** or search for them.

Use **••• → Edit details** to change a task name or purpose without restarting
it. The menu also offers **Stop** and **Start**. **Running** means the terminal
process exists; it does not indicate whether the model is working or waiting
for input. **Ready to start** sessions start when opened. Names, purpose notes,
and stop state are shared between browsers and saved
under `/data/agent-terminal/sessions/`. Each Claude and ChatGPT terminal also
remembers its own conversation ID under `/data/agent-terminal/conversations/`.
Opening it after an exit, Stop/Start, or add-on update resumes that exact
conversation, even when several tasks share a provider and workspace. A
**Ready to resume** label identifies saved conversations whose process is gone.
Choose **+ New session** for a separate conversation. The provider's own
`/resume` or `/clear` (Codex: `/new`) commands update the association too.

Sessions created before this feature have no recorded conversation ID. After
upgrading, select their previous conversation once with the provider's
`/resume` command; the terminal remembers that choice afterwards. It never
guesses from the most recent conversation in a shared workspace.

On screens at least 960 pixels wide, **Split view** immediately opens a second
pane while keeping your current terminal visible on the left. Choose an
existing task or **+ New session** in the right pane; nothing attaches or starts
there until you choose. **Cancel** removes the empty pane. You can also choose
**Open beside** from a session's menu to open that session directly. Drag the
divider to resize the panes, or focus it and use the left/right arrow keys.
Each pane has independent typing, clipboard, and helper-key controls. The
keyboard stays with the pane you are typing in: a pane that loads, switches
session or reconnects in the background never takes it. After a reload it
starts in the left pane. The
browser remembers both selections and the divider position across reloads.
**Unsplit** or **Close** hides the second pane and leaves its agent running.
Narrowing the screen returns to one pane, keeping the focused session visible.

**Start fresh** in a session’s **•••** menu ends its terminal process and opens
a new conversation with the same provider, workspace, name, and purpose. Use
this when Codex keeps resuming a conversation that is locked or open in Phone
remote. The old terminal stays stopped, including in other browsers; its saved
conversation and workspace files are kept. A conversation running separately
in Phone remote can continue there without blocking the new terminal.

**Stop** ends the running process after confirmation. Automatic reconnects
from other browsers cannot restart it; **Start** explicitly allows a fresh
process and resumes the saved conversation. Closing a pane, switching
sessions, and closing the browser only detach. A full add-on restart still
ends running processes; named session metadata and provider-saved
conversations survive, but running tasks do not.

For a temporary session you no longer need, choose **Sessions → ••• → Delete**
and confirm. This ends its task and removes the added session from every
browser, including its terminal scrollback. Workspace files, uploads, provider
logins, and provider-saved conversations are kept. A deleted session cannot
be restarted; create a new one when needed. Built-in provider sessions can
be stopped but cannot be deleted.

Sessions in the same workspace can edit the same files. Use separate folders
or Git worktrees when independent coding tasks need separate working copies.

SSH can attach to a named session using its ID (the third `arg` in its URL):

```sh
agent-session --session session-0123456789abcdef0123456789abcdef
```

The browser remembers your selection. The `agent` option supplies the first
choice in a new browser. An existing `web_command` adds a **Custom** button
and supplies the initial choice; the Claude, ChatGPT, and Shell buttons still
launch their own commands. With `mobile_ui: false`, the stock ttyd client has
no selector and starts the configured default.

SSH can attach to the same sessions:

```sh
agent-session --agent codex --workspace homeassistant
agent-session --agent shell --workspace automations
```

Closing the page or switching away only detaches. Exiting the CLI ends its
process; an open panel reconnects and resumes that conversation in a new
process. A launch error stops the terminal instead of repeatedly relaunching
it; resolve the error, then choose **Start**. Use **Sessions → ••• → Stop**
to stop it without automatic relaunch. A full add-on restart stops all live
sessions.

### Task workspaces and skills

Click **Shell**, then create a workspace:

```sh
agent-workspace create automations "HA automations"
agent-workspace create dashboards "Dashboard work"
agent-workspace list
```

Reload the panel to see new workspaces in its selector. The existing sessions
stay alive. These examples create persistent folders under
`/share/agent-terminal/workspaces/`. Workspace registrations live under
`/data/agent-terminal/workspaces/` and survive updates.

Each newly created folder contains:

| Path | Purpose |
|---|---|
| `AGENTS.md` | Shared task goals, coding conventions, relevant paths, and checks. Edit this to describe the workspace's job. Codex reads it directly. |
| `CLAUDE.md` | Imports `AGENTS.md` so Claude reads the same instructions. |
| `.agents/skills/` | Add a folder per skill with its own `SKILL.md`. Codex discovers these project skills. |
| `.claude/skills` | Links to the same skill directory for Claude. |

For example, a skill file at `.agents/skills/check-automations/SKILL.md` needs
YAML frontmatter with `name: check-automations` and a `description` saying when
to use it, followed by its instructions. Use the common skill format for
shared skills; provider-specific options may behave differently. Restart the
CLI in that workspace after changing instructions or skills so it reloads them.
See [Codex skills](https://developers.openai.com/codex/skills/),
[Claude skills](https://code.claude.com/docs/en/skills), and
[Claude's AGENTS.md import](https://code.claude.com/docs/en/memory).

To register an existing project, supply an absolute path:

```sh
agent-workspace create my-addon "My add-on" /addons/my-addon
```

Existing folders are left untouched, so keep or add the project's own
instructions and skills there. Registering a workspace does not clone a
repository or install dependencies. Agents and shells start in the selected
folder; commands such as `npm install` can set up that project's dependencies.
The built-in **Home Assistant** workspace continues to use `/homeassistant`.

Workspaces organize files, instructions, and conversations within the **same
container**. They share provider logins, installed tools, mounted files, and
Supervisor access. They are **not security sandboxes**, and `AGENTS.md` is
guidance, not a permissions boundary. An agent working on a separate project
can still access HA. Concurrent agents can edit the same files; use separate
project folders or Git worktrees when tasks need independent changes.

## Copy and paste (sidebar panel)

- **Copy: selecting is copying.** Whichever selection you make, the text is on
  the clipboard when the selection settles and a "Copied N characters" toast
  confirms it. That covers Claude Code's and Codex's own drag-select, tmux
  copy-mode (mouse drag, or `Ctrl-b [` and Enter), **Shift+drag** (Option+drag
  on a Mac) anywhere on screen, double-click, and Select all. Ctrl+C /
  Ctrl+Shift+C / ⌘C and right-click → Copy still copy and confirm; Ctrl+C with
  nothing selected interrupts, as always.
- **Paste:** Ctrl+V / Ctrl+Shift+V / ⌘V, or right-click → Paste (needs HTTPS).
  On a phone, tap **Keys → Tools → Paste** (or long-press → Paste): a paste box opens with the
  keyboard. Long-press in it and choose Paste (or tap the keyboard's clipboard
  suggestion) and it goes straight to the terminal. Typed text needs **Send**.
- **Esc twice on a phone:** tap **Keys**, then **Esc²**.
- **On a phone, long-press the terminal** for a menu: Select text…, Copy
  screen, Paste, Attach file or photo…
- **Copy on a phone:** scroll to what you want, then long-press → **Select
  text…** (or tap **Copy** on the key bar). The screen opens as plain text:
  select with your phone's handles and it copies itself once they settle.
  **Copy** confirms it, **Copy all** takes the whole screen, **Done** goes
  back. (Over plain HTTP, where the browser has no clipboard API, use the
  buttons — a tap is the gesture that lets the copy through.)
- **Right-click** opens the terminal's menu; **Shift+right-click** opens the
  browser's. Tick **Right-click pastes** in that menu for Windows Terminal
  behaviour: right-click copies the selection, or pastes when nothing is
  selected, and Shift+right-click opens the menu.

### Editing with a desktop keyboard

In Claude, ChatGPT, and Shell sessions, click the terminal and use:

| Shortcut | Action |
|---|---|
| **Ctrl+Left / Ctrl+Right** | Move backward / forward by one word. |
| **Ctrl+Backspace** | Delete the previous word. |
| **Ctrl+Delete** | Delete the next word. |
| **Shift+Enter** | Add a line without sending in Claude and ChatGPT prompts. |

On a Mac, **Option** with the arrows, Backspace, or forward Delete uses the
same word commands. The terminal sends standard readline commands; each
program defines its word boundaries. Custom sessions retain their original
terminal key sequences. Shift-modified navigation continues to reach the program,
including selection shortcuts supported by that program.

Physical **Shift+Enter** sends the agents' newline shortcut, **Ctrl+J**, so it
works through tmux without extended keyboard support. Plain **Enter** still
sends or confirms. You can also use **Keys → Edit → ↵ (New line)**; while a
draft or paste field is open, the helper adds a line there without sending it.

Session search, task names, purpose notes, and the mobile draft are native
text fields, so they keep the browser's normal editing shortcuts. Only the
focused terminal receives terminal shortcuts, including in split view.

## Attaching files and images (sidebar panel)

Give the agent a screenshot, a photo, a PDF or a log without leaving the panel:

- **Paste a screenshot:** Ctrl+V / ⌘V with an image on the clipboard.
  Right-click → Paste does the same over HTTPS.
- **Drop files** on the terminal. In split view they go to the pane they
  land on.
- **Pick files:** right-click → **Attach file…**. On a phone, tap the
  paperclip beside the draft, long-press → **Attach file or photo…**, or
  **Keys → Tools → Attach**, and choose the camera, a photo or a file.

The file is saved in the add-on and its path is pasted into the prompt, so you
can go on typing your question after it. Claude Code and Codex turn the path
of a PNG, JPEG, GIF or WebP into an attached image, shown as `[Image #1]`.
Any other file stays a path, which the agent reads once you send the message.
In a Shell session it is just the path.

Enter pressed while a file is still uploading waits for it, so the prompt is
sent with its attachment. If the upload fails, the prompt stays in the editor
and the page says it was not sent.

- Files go to `/data/agent-terminal/uploads/<date>/`, named with the time and
  a simplified version of their own name. Each can be up to 50 MB.
- They are kept for 7 days, then removed when the add-on starts or the next
  file is attached, and they are left out of the add-on's backups. Ask the
  agent to copy a file elsewhere if it should stay.
- Large JPEG, WebP and HEIC photos are sent as a JPEG no more than 2048 pixels
  on its long side: the agents use no more, and it uploads in a moment from a
  phone. PNG screenshots and every other file go unchanged.
- Text wins on paste. A spreadsheet copies cells as text with a picture of
  them; that pastes the text.
- A file that finishes uploading after you switched sessions is saved but not
  typed into the other session; a message shows where it is.
- So that Claude reads attached files without asking, start-up adds the
  uploads folder to `permissions.additionalDirectories` in Claude's
  `settings.json`, once, leaving the rest of the file as it is.
- Attaching needs the add-on's own page (`mobile_ui: true`, the default). Over
  SSH, copy the file instead (`scp -P 2202 shot.png root@<ha-host>:/tmp/`) and
  type its path.

## Voice prompts (sidebar panel)

Tap the **microphone** in the top bar, or choose **Voice prompt…** from the
right-click or long-press menu. Allow microphone access, speak, then tap the
microphone again or **Finish**. The text is added to your editable draft;
review it and press **Send**. Dictation preserves text already in the draft
and never submits a command automatically.

Voice prompting uses the speech-to-text provider and language of your
preferred assistant in **Home Assistant Settings → Voice assistants**. A local
Whisper provider keeps transcription local; a cloud provider uses that
provider's service. No separate API key is needed in the add-on. The add-on
holds audio in memory for transcription and does not save recordings.

Use an HTTPS Home Assistant address and a browser or companion-app webview
that grants microphone access. If access is denied, allow the microphone in
the browser or phone's app permissions. Over plain HTTP, or in an unsupported
webview, the phone keyboard's dictation can still enter text into the draft.
Microphone recording is limited to two minutes. Closing the draft, switching
sessions, stopping the session, or hiding the page cancels recording and any
pending transcription. Split panes keep their voice drafts separate.

## Health monitoring and alerts

Open **Sessions → Health**. Monitoring starts off. Choose the Companion app
notification service for each phone, optionally list important entity IDs
(one per line), and choose the agent that should review incidents. Save your
settings, use **Test saved reviewer** to check the connection with synthetic
evidence, then enable monitoring and save again. The test sends no alert and
does not include your logs.

The reviewer can be **Rules only**, **Local Ollama**, or a **Home Assistant
conversation agent**. Ollama connects directly to your server, for example
`http://YOUR_OLLAMA_HOST:11434`, and an already installed local model. It never
downloads a model or falls back to a cloud provider. The review request has
no tools. Home Assistant lists only conversation agents with Home Assistant
control turned off, and checks that setting before every review. That agent's
configured provider receives the evidence, so choose a local provider if you
want reviews to stay local. Claude, ChatGPT, or Ollama can be selected separately for
investigations.

The worker checks once a minute using the latest 1,000 Supervisor journal
records from Home Assistant Core. Enabling establishes the current log as a
baseline; older errors are ignored. Repeated new errors are grouped and
reviewed after the configured count and delay. Important entities must remain
missing, unknown, or unavailable for the delay. New critical errors and known
storage/configuration failures are eligible immediately. Those failures and
important entity outages remain major even if a model downgrades them.
Other model assessments send alerts only for major severity with at least
80% reported confidence. That confidence is the model's assessment, not a
measured probability. Rules only, or a failed reviewer, alerts on qualifying
recurring errors too; select a reviewer to filter limited-impact failures.

Alerts have **Investigate**, **Snooze 1h**, and **Dismiss** actions. Investigate
opens the incident in the panel; choose **Investigate** there to open a named
Claude, ChatGPT, or Ollama session with a diagnostic draft. For Ollama, finish
the terminal's model selection first. Review the draft and press **Send**.
Existing investigation sessions are reused. The monitor itself
does not restart services or change Home Assistant state. Snooze pauses
reminders for an hour; Dismiss silences that incident until it recovers and
recurs. The cooldown controls reminders, and a stable notification tag replaces
earlier alerts. Recovered entities clear their alerts. Log incidents clear
after a quiet period and are labelled **Quiet**, which does not prove that
the underlying device recovered.

Settings, incidents, acknowledgements, and delivery history persist under
`/data/agent-terminal/health`. Common credentials are redacted before logs are
saved or reviewed, and incident text is displayed as plain text. Evidence
is bounded to the latest log entries and 100 incidents. The monitor depends
on this add-on and Home Assistant's API and notification services being
available; it cannot send an alert while Home Assistant itself is offline.

## Options

| Option | Default | Description |
|---|---|---|
| `authorized_keys` | `[]` | SSH public keys allowed to log in. Empty = SSH effectively unusable (no keys accepted). |
| `ssh_port` | `2202` | Port sshd listens on. Also update the add-on's `ports` mapping if you change this. |
| `agent` | `claude` | Initial choice: `claude` (Claude Code), `codex` (ChatGPT), or `ollama` (local models). Switch live with the panel buttons. |
| `web_command` | *(empty)* | Optional trusted shell command for the separate Custom session and initial web selection. Use the Shell button for a plain shell. |
| `mobile_ui` | `true` | Serve the terminal with agent/workspace controls and touch support. Set `false` for ttyd's stock client without these controls. |
| `git_user_name` / `git_user_email` | `""` | Optional system-wide git identity for commits made from this add-on. |

## Using it from a phone

The sidebar panel serves a terminal page built for touch, including the Home
Assistant companion app.

- **The bottom row is always there:** **Esc**, **← ↑ ↓ →**, **Enter** and
  **Keys**, the keys the agents ask for most (interrupting, moving through a
  menu or between questions, confirming). Keys is outlined, as a control
  rather than a key, and set slightly apart so a slipped tap doesn't send
  Enter.
- **Keys opens a single row** of grouped keys, so the panel never takes more
  than one row. It starts with the agent keys; the button at its right end,
  directly above Keys, names the group and lists the others in the same row:

  | Group | Keys |
  |---|---|
  | Agent | Tab, Mode, Answer, Esc², Ctrl+C, Space |
  | Ctrl | Ctrl, Alt, Shift, tmux |
  | Edit | ↵ (New line), Bksp, Home, End, PgUp, PgDn |
  | Tools | Copy, Paste, Attach, Direct, A−, A+ |

  The group button stays put, so tapping it twice returns you to where you
  were. Reloading, switching an agent/workspace, or starting a new draft
  closes Keys; an old saved expanded-toolbar preference is ignored. You can reopen Keys while typing: keyboard resizing leaves your
  choice alone.
- **Answer Codex questions:** **Keys → Answer** (Codex's Shift+Left), choose
  with the arrows, then **Enter**. Tab moves between fields; Space toggles a choice where supported.
- **Write a prompt:** tap the terminal to open a compact draft and the phone
  keyboard. The response stays visible and scrollable. **Enter** or **Send**
  submits; **Shift+Enter**, **↵** beside the draft, or **Keys → Edit → ↵** adds a line. The helper
  Enter button also submits an open draft. Tap **×** to close without sending.
  Autocorrect and composition edits stay in the native draft; Send pastes the
  final value once and submits after composition finishes. Enter used to accept
  an IME candidate does not submit. Reopening an active draft preserves its
  editor and text. Paste keeps autocorrect off for literal pasted content.
- **Drag on the terminal to scroll**, even while a draft is open or output is
  streaming. Drags send wheel events to programs that request mouse tracking,
  and otherwise scroll terminal history. Long-press opens the selection/copy/paste menu.
- **Modifiers and direct input:** the **Ctrl** group has Ctrl, Alt, and
  Shift. Each applies to the next terminal key; armed modifiers are shown on
  the Keys button even after switching groups. Collapsing helpers clears
  them. **Direct** opens the original terminal keyboard for single letters or
  shortcuts: for example, reopen Keys → Ctrl and tap Ctrl, then type r for
  Ctrl+R. Direct stays highlighted until the keyboard closes. Disable phone
  autocorrect in Direct mode: xterm's live IME can replay text
  ([upstream report](https://github.com/xtermjs/xterm.js/issues/6078)).
  Physical keyboards work normally.
- **tmux:** Keys → Ctrl → tmux sends the default Ctrl+B prefix. In Direct
  mode, follow with `[` to scroll or `d` to detach. Tap tmux twice to pass
  Ctrl+B through to Claude's background-task control.
- **Touch targets are at least 44 × 44 pixels** on phones 350 pixels wide or
  larger. Between 320 and 350 pixels, the seven-key rows (the bottom row and
  the agent keys) are at least 40 pixels wide. Keyboard actions run on a completed tap. Scrolling, long-press menus,
  and cancelled touches do not open the draft. The page fits above the keyboard;
  the session selector uses one row when the available height is small.
- **Collapse the top bar** with **⌃** for about four more lines of output; the
  strip that replaces it brings it back. Collapsing or expanding it while
  writing keeps the draft and the phone keyboard open. On a narrow phone
  with the keyboard up, the keyboard button steps aside so the one-row bar
  still fits.
- **Hide the helpers entirely** with the keyboard button at the right end of
  the top bar, for example on a tablet with a keyboard attached. A tap on the
  terminal then types into it directly, as Direct does. Tap the button again
  to bring the keys back.
- **Turn the phone on its side** and the helper keys move to a column on the
  right, since width is what is left over then. The draft shrinks to one line,
  so the terminal keeps several rows visible above the keyboard.
- **Coming back to the app reconnects right away**, instead of waiting out the
  retry delay that built up while the phone was asleep.
- Text size, the keyboard button and the top bar are remembered per device.
  Append `?keys=1` or `?keys=0` to the address to override that choice for one
  visit. Set `mobile_ui: false` to use ttyd's stock client.

### Helper keys on a desktop

The helper keys are hidden on desktop, since a physical keyboard has every
key. If yours is missing one (an Esc key, say), or the browser or OS takes a
shortcut first, click the keyboard button at the right end of the top bar.
The keys open with the agent keys, drawn as a compact centred keypad.
Clicking them leaves the terminal focused, so you can keep typing. The browser
remembers the choice, and later visits start with just the bottom row. **Direct** isn't offered, because typing already goes straight to
the terminal.

### Shared shortcut map

The helper buttons send the same terminal keys for either agent. The running
program and its keybindings decide the action; these are the default meanings.
Navigation and shortcut keys act on the terminal even while an unsent native
draft is open. The ↵ helpers edit an open draft or paste field locally;
Enter submits a draft.

| Button | Keys sent | Claude | Codex |
|---|---|---|---|
| Enter | Enter | Submit / confirm | Submit / confirm |
| Esc | Escape | Interrupt / close a dialog | Cancel / close a dialog |
| Tab | Tab | Complete / next field | Complete / next field; queue while working |
| Mode | Shift+Tab | Cycle permission modes, including Plan | Toggle Plan mode |
| Answer | Shift+Left | Ordinary Shift+Left | Open pending questions |
| Esc² | Escape twice, spaced apart | Rewind with an empty prompt; clear nonempty input | Edit previous message with an empty prompt |
| ↵ (Edit keys or beside a draft) | Local newline in an open text field; otherwise Ctrl+J | Newline | Newline |
| Ctrl+C | Ctrl+C | Clear input / interrupt; twice on an empty prompt exits | Clear input / interrupt; twice on an empty prompt exits |

Arrows and Space keep their normal navigation/selection behavior. The Edit
group has Backspace (Bksp), Home/End and page scrolling; Tools has Copy/Paste, Attach,
Direct and A−/A+.
See [Claude's shortcut reference](https://code.claude.com/docs/en/interactive-mode),
[Codex's interactive commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#interactive-shortcuts),
and [Codex Plan mode](https://learn.chatgpt.com/guides/best-practices#plan-first-for-difficult-tasks).

## Adding an agent

Everything agent-specific lives in one file, `rootfs/opt/agents/<agent>.sh`.
The rest of the add-on (web terminal, tmux, SSH, MCP server) only talks to
that file through this contract:

| Name | Kind | Purpose |
|---|---|---|
| `AGENT_TITLE` | variable | Display name (panel title, motd). |
| `AGENT_COMMAND` | variable | Command the session runs when `web_command` is empty. |
| `AGENT_DATA` | variable | Directory under `/data` holding the login and settings. |
| `agent_install` | function | Build time: install the CLI into the image. |
| `agent_env` | function | Print `NAME=value` lines the CLI needs (config dir, etc.). |
| `agent_run` | optional function | Run the interactive CLI, resuming `AGENT_CONVERSATION_ID` when set. Called inside the tmux pane by `agent-run`; adapters without it use `AGENT_COMMAND`. |
| `agent_init` | function | Boot time: point the CLI's config at `AGENT_DATA`. |
| `agent_register_mcp NAME CMD [ARGS...]` | function | Register a stdio MCP server in the CLI's own config format. Must be idempotent and must never overwrite a file it can't parse. |
| `agent_login_help` | function | Print first-run login steps for the motd. |

[`claude.sh`](rootfs/opt/agents/claude.sh) is the reference. To add one:

1. Copy it to `rootfs/opt/agents/<agent>.sh` and implement the contract.
2. Add the name to `ARG AGENTS` in the Dockerfile (or pass it via
   `build.yaml` args) so the CLI is installed.
3. Add it to the `agent` schema in `config.yaml`: `list(claude|<agent>)`.
4. Add its ID to `agent-session`'s validated mode list, the session validators
   and metadata in `sessions.mjs`, and the metadata in `workspaces.mjs` (and
   the fallback in `index.template.html`). The first
   three toolbar entries have Ctrl+Shift+1 / 2 / 3 shortcuts.

Switching `agent` keeps each agent's data in its own `AGENT_DATA`, so logins
survive switching back and forth.

### Checking the Codex adapter

With Python 3.11+, Bash, Node, and the Codex version pinned in `codex.sh` on
PATH, install the MCP and Remote clients' dependencies and run from the repository root:

```sh
npm install --prefix agent-terminal/rootfs/opt/ha-mcp --no-package-lock
npm ci --prefix agent-terminal/rootfs/opt/agent-terminal --ignore-scripts
python3 -m unittest discover -s tests -v
node --test tests/test_*.mjs
```

These checks use the real CLI to register and inspect MCP servers in temporary
directories. They verify that settings, credentials, and saved sessions are
preserved, tool restrictions survive restarts, malformed TOML is rejected,
and Codex discovers the built-in HA tools. They do not sign in or make model
requests.

The `Validate add-on` GitHub Actions workflow builds complete images on native
AMD64 and ARM64 runners and runs the checks inside each image. It also tests
first-boot option import, SSH/login environments, tmux, agent switching, and
the Supervisor token-file fallback against a local mock HA API.
Node tests cover workspace validation and persistence, safe HTML metadata,
out-of-order browser connections and clipboard input, and real ttyd WebSocket
sessions with stub provider commands. They verify that switching preserves
processes, separates workspaces, keeps login-shell working directories, and
serves newly created workspaces without restarting ttyd.
`tests/test_sessions.mjs` uses a separate temporary tmux server to check named
process isolation, persisted stop state, deletion without removing workspace
files or restarting on reconnect, input validation, and concurrent lifecycle
operations. It requires tmux and `flock` (both supplied by the
add-on). The container integration test exercises management requests and
readline word editing through the real ttyd WebSocket, PTY, and tmux,
alongside named provider terminals. It also sends a file through that PTY
and compares the saved bytes.
`tests/test_uploads.mjs` checks the upload receiver on its own: file-name
cleaning, the size limit, malformed and incomplete uploads, partial files
removed on disconnect, and the weekly clean-up. `tests/test_webui.mjs` runs
the page's side of it: pasted, dropped and picked files, chunking, a failed
file, a session switched mid-upload, and an Enter that waits for its file. It
also checks that keys typed while a session connects arrive once tmux has
attached, and that a split pane's connection does not take the keyboard. The
browser suite repeats paste,
drop and the phone's Attach button with real events, and checks that a large
photo arrives as a 2048-pixel JPEG.
`tests/container-smoke.sh` is only for these disposable test containers.
Live ChatGPT sign-in and operations against a real HA instance are manual
acceptance checks after installation.

`tests/test_remote.mjs` uses a simulated Codex child and an isolated Unix
WebSocket server to check startup, persisted enablement, failure recovery,
protocol initialization, and private pairing replies. It makes no model or
relay requests. The browser suite checks the Remote dialog, phone layout,
keyboard focus, and clearing a pairing code when the dialog closes.

`tests/test_voice.mjs` checks the speech provider selection, PCM transport,
limits, cancellation, timeouts, and the control stream without contacting
Home Assistant. `tests/test_voice_client.mjs` covers microphone permissions,
audio resampling, cleanup and late transcriptions. The browser suite uses
Chromium's synthetic microphone with real Web Audio to verify that dictation
fills a draft and only **Send** submits it.

`tests/test_health.mjs` covers baseline cursors, recurring errors, entity
outages and recovery, secret redaction, reviewer validation and tool-free
requests, cloud-model rejection, failed reviews, cooldown/delivery history,
notification actions, persisted acknowledgements, and investigation sessions.
It uses temporary stores and mock APIs. The browser suite checks settings,
plain-text evidence, phone layout, snooze, and an investigation draft that
stays unsent. Run the worker checks with `node --test tests/test_health.mjs`.

`tests/test_ollama.mjs` checks installed-model discovery, cloud and unsupported
model rejection, server validation, remembered per-session selections, and
launcher credential isolation. Session tests verify exact local conversation
resumption. Browser checks open general and named Ollama sessions and verify
the four-provider phone layout. These suites do not contact a real model.

### Checking the terminal controls

With Node 22+, run from the repository root:

```sh
node tests/test_webui_keys.mjs
```

These checks execute the page's handlers with a simulated DOM, xterm API, and
WebSocket. They cover the question-answer sequence, modifiers, Claude controls,
pointer repeat, keyboard activation, minimized helper state, modifier cleanup,
draft composition/paste handling, the keyboard button and the collapsible top bar.
They make no model requests and do not send keys to a live session.

For browser regression coverage, build the web UI with its normal build script,
then point the test at Chromium and the resulting bundle:

```sh
CHROMIUM_BIN=/usr/bin/chromium WEBUI_BUNDLE=/path/to/index.html node tests/test_webui_browser.mjs
```

The browser suite also creates and renames sessions, routes real keystrokes
to separate split panes, resizes and restores the split, stops and restarts
a session, deletes temporary sessions without disturbing another pane, and
checks workspace groups, purpose search, and the picker on a
narrow screen. Desktop checks exercise Ctrl+Left/Right, Ctrl+Backspace and
Ctrl+Delete, Shift+Enter, unmodified character editing, native text fields,
and shortcuts in the focused split pane. It checks the New line helper in
direct input and an open draft, including its touch target on a narrow phone.
The suite also verifies that opening or
canceling an empty second pane never connects to an agent, and that creating
a task there preserves the left terminal. Its management transport
is simulated; it does not send keys or lifecycle operations to live agents.

The browser test uses real touch activation and composition events with the
bundled xterm, including repeated word replacement, Korean composition, and
live Ctrl/Answer/arrow/Enter controls. It checks minimized defaults, expansion
while typing, terminal visibility, touch targets on a 320px phone in every
state of the one-row key panel, the group button keeping its spot, a drag that keeps scrolling while xterm
redraws the rows under it, the keyboard button and top bar collapse on a phone
and on a desktop, and the side column on a phone turned sideways.
Its WebSocket is replaced before page
code runs, so all input stays inside the test. The test skips unless
`CHROMIUM_BIN` is set; CI installs Chromium and runs it on both architectures.
Actual phone keyboard behavior still needs a device check.

### Exploring the UI with a local vision model

`tools/ui-explorer/run.mjs` runs a manual exploratory session in Chromium. An
Ollama vision model receives a screenshot, chooses a click, drag, key, text
entry, or scroll, then receives the result as another screenshot. There are
no scripted click paths, selectors supplied to the model, or Playwright
dependencies. The existing regression suite remains the repeatable check.

Run this on a dedicated test machine as an ordinary user with Node 22+ and
Chromium installed. Build the page there (not inside the running add-on):

```sh
cd agent-terminal/rootfs/opt/webui
npm install --ignore-scripts --no-audit --no-fund
node build.mjs
cd ../../../..
export OLLAMA_URL=http://YOUR_OLLAMA_HOST:11434
node tools/ui-explorer/run.mjs --check
node tools/ui-explorer/run.mjs --steps 16 --minutes 8 \
  --goal 'Create a second ChatGPT session, then use two different sessions side by side.'
```

The default model is `qwen3-vl:4b-instruct`; select another installed vision
model with `--model`, for example `qwen3.5:4b`. The controller disables thinking
when the model advertises that capability. `--check` inspects the model's
metadata and opens the test page without running inference. Models are never
downloaded automatically. The Ollama request uses its [vision input](https://docs.ollama.com/capabilities/vision)
and [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

Each run gets a new browser profile, fixture server and session store. The
page uses the same inert WebSocket/session backend as the browser regression
suite. Real UI controls and bundled xterm run normally, but terminal input is
recorded only: these trials do not validate real Claude/Codex editing, tmux,
provider authentication or Home Assistant integration. No production or
provider credentials are needed. The browser can request only the local test
origin; its debugging connection is a private pipe. There is no live-site URL
option and the model cannot evaluate JavaScript or run shell commands.

Screenshots before and after each action, input packets, session state,
browser errors, model timings and a report are saved under
`artifacts/ui-explorer/` by default. Use `--output` for another new directory.
`--bundle` selects a previously built UI revision; reports record its SHA-256
and the controller checkout's commit. `--width` and `--height` set the desktop
viewport; a narrow viewport does not emulate a phone's touch or native keyboard.

Runs stop at the decision/time budget, on three consecutive invalid actions,
after repeated identical actions leave the screenshots unchanged, or when
the model finishes. Ctrl+C cancels a model request and saves the
available evidence before closing the browser. A model saying it is done is
not a passing test: review the screenshots and actual fixture state, and
reproduce suspected defects before filing them. Archive useful findings and
selected evidence in Git; generated runs are ignored by default.
The [initial trial record](../tests/evidence/ui-explorer/initial-trials.json)
includes action traces and selected screenshots. Session creation worked;
the models did not complete the full split-view task in those trials.
The [independent review](../tests/evidence/ui-explorer/reviewed-findings.json)
verified that two existing sessions open in separate panes and that Purpose
accepts an empty value. The model had clicked behind an open dialog and
misidentified the required Task name field; those observations did not
reproduce a functional app defect.

This tool makes requests only when launched explicitly.
Run its controller checks with `node --test tests/test_ui_explorer.mjs`.
On the dedicated machine, also verify Chromium isolation with
`UI_EXPLORER_BROWSER_TEST=1 node --test tests/test_ui_explorer_browser.mjs`.

#### Running an exploration through GitHub Actions

The **Explore UI with local Ollama** workflow builds the page, checks the
controller and browser, then lets the vision model choose its actions. It
uploads screenshots and reports as an Actions artifact retained for 14 days.
Its green status describes execution of the harness, not completion of the
model's goal. Review the evidence and preserve useful findings in Git.
The [first runner trial](../tests/evidence/ui-explorer/github-runner-trial.json)
passed all five checks and reached two different ChatGPT sessions side by
side by action 9. The model kept clicking after achieving that state, so
the repetition guard ended the exploration at action 14 with `stalled`.
The reviewed screenshot and findings are kept alongside the trial record.

Runs are explicit: the repository owner can use `workflow_dispatch`, or push
a `ui-explore/NAME` tag pointing at a reviewed commit. The tag also works
before the workflow reaches the default branch. There are no pull-request
or scheduled triggers. Inputs are passed as quoted environment variables,
the job token has read-only contents access, and checkout does not retain it.
The lab's Ollama endpoint comes from the repository secret
`UI_EXPLORER_OLLAMA_URL`, which keeps the address out of this repository and
the run logs.

Each run requires a fresh ephemeral runner on the dedicated tester VM. The
runner is registered with only `ui-explorer-RUN_ID-ATTEMPT` as its label, so
ordinary `self-hosted` jobs cannot select it. It accepts one job, unregisters
afterward, and has a 15-minute service deadline. There is no boot-time service.
The account has neither sudo nor Docker access; its service protects home
directories and writes only to its own directory and private temporary files.
This does not make public pull-request code safe: run reviewed commits only,
as described in [GitHub's self-hosted runner guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners).

On VM 230, an administrator prepares the pinned, checksum-verified runner with
`sh tools/ui-explorer/prepare-github-runner.sh`. After queueing the workflow,
use its numeric run ID and attempt (initially `1`) to register and start it.
The following runs on the administrator's authenticated machine, with
`TESTER_SSH_HOST` set to the SSH alias for the VM and `RUN_ID` set to the queued
run. The alias must use the verified VM host key and the tester SSH identity:

```sh
gh api --method POST repos/modert/agent-terminal-ha-addon/actions/runners/registration-token \
  --jq .token | ssh "$TESTER_SSH_HOST" \
  "sh /opt/agent-ui-tester/repo/tools/ui-explorer/start-github-runner.sh $RUN_ID 1"
```

The VM receives only the short-lived registration token, not the administrator's
GitHub credentials. Logs are available with
`sudo journalctl -u ui-explorer-RUN_ID-ATTEMPT`. After the job, verify it has
left the repository's runner list. If registration succeeded but the service
failed or expired before accepting a job, remove that specific runner through
GitHub's runner settings/API and remove its `.runner`, `.credentials`, and
`.credentials_rsaparams` files on the VM before registering another run.
The IP reservation and private infrastructure repository remain host-managed.

## Known limitations

- The live tmux process and any running task do **not** survive a full add-on
  restart or update. Login, settings and recorded conversation IDs persist;
  reopening a terminal resumes its conversation but does not automatically
  retry an interrupted action. Detach/reattach across browser or SSH
  drops keeps the live process running.
- The first `http://supervisor/core/api/...` call right after boot can return
  `502` for a few seconds while the proxy warms up - retry.
- Editing `custom_components/*.py` still requires `ha core restart` to take
  effect (Python module caching).
- Tested on amd64/aarch64 HAOS. Not tested on armv7/armv6.

## Support

This is a personal add-on, shared as-is with no support commitment. Read the
source before you install it - it's short enough to actually read.
