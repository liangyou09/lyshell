# LyShell User Manual

> LyShell is a Windows terminal with a built-in MCP server — your terminal, now AI's terminal too.
> SSH / Telnet / serial / local PTY sessions, with Claude Code and other AI clients able to drive them directly.

This manual covers everything LyShell can do. Use the outline rail on the left to jump between sections; `Ctrl + scroll` zooms the text, and the hand tool pans the view.

## Interface Overview

| Area | Contents |
|------|-----------|
| Left column · rail | The icon column — nine panels (`Alt + 1…9`), sessions slot shows a live LED count |
| Left column · panel | Sessions / Agents / DeepSeek Harness / Codex / Claude / Env / Plugins / Web / Settings |
| Terminal column · tab bar | Browser-style tab bar lifted to the window's first row; doubles as the window drag area |
| Terminal column · panes | Recursive split tree, horizontal / vertical |
| Session panel bottom | LIVE-row terminal readouts (charset, cols × rows, buffer lines) + quick-command groups |

The sidebar collapses (button at the top of the rail) leaving an L-shaped inner frame that lights up on hover to expand — giving the terminals full width.

## Connections

### Connection types

| Type | Key parameters | Notes |
|------|---------------|-------|
| SSH | password or private key; port `22` | Post-login commands, keepalive, dual-click clone |
| Telnet | host + port `23` | Full IAC negotiation |
| Serial | COM port, baud `115200` (9600–921600), 8N1 | Auto-detects ports |
| Local PTY | cmd.exe / PowerShell | Configurable working directory + env |

### Creating a session

1. Click **+** at the top of the session list, pick a connection type
2. Fill in host, port, authentication (password or key path)
3. Click **Connect** — the tab turns 🟢; the config is saved to the sidebar

- **Shell init commands** — devices needing `shell` → `enable` before the CLI works: list them line by line and LyShell sends them in order
- **Encoding** — garbled text on an SSH session? Edit it and switch UTF-8 to GBK / GB2312
- **Summary / usage notes / tags** — optional session metadata, searchable by you and by MCP clients

### Connection status

Tab status dots: 🟢 connected · 🔴 error · ⚪ disconnected · 🔵 new output. Sessions in the sidebar also get TCP reachability probes, shown as "TCP reachable · not connected".

## Terminals

### Tabs

- **Clone session** — double-click the tab's left half; same config, fresh terminal
- **Clone channel** — double-click the tab's right half (SSH only); reuses the authenticated connection, no re-login
- **Drag** — drop a tab on a pane edge to split it into its own pane; drop it on a pane's center to remount as a tab
- **Shrink** — the tab bar shrinks tabs Edge-style as space runs out (shrink-only, no scrolling); hover for the detail card
- **Close** — ✕ disconnects; closing every terminal tab returns the pane to the empty-state command screen. If a doc tab is parked there (an `/ls` inventory, etc.), it stays parked on the tab bar and the command screen takes the keyboard; parked dsh web / web / MCP audit panels pop back open instead

### Splits

`Ctrl + Shift + H` splits horizontally, `Ctrl + Shift + V` vertically. Dragging tabs / sessions to an edge works too. Drag the divider to adjust the ratio; layouts auto-save and survive restarts.

### Copy, paste, search

| Action | How |
|--------|-----|
| Copy | Selecting text copies automatically |
| Paste | Right-click |
| Search | `Ctrl + F` or middle-click; regex, case-sensitive, whole-word, and cross-tab scopes |

### Terminal readouts

In the LIVE row at the bottom of the session sidebar: click "cols × rows" to clear the screen (keeps scrollback); click the buffer-line count to scroll to bottom, double-click to clear scrollback. The readout also shows the protocol code and charset (shown for SSH / Telnet / serial; local terminals are always UTF-8 via ConPTY and show no charset). Click the charset to open a picker (UTF-8 / GBK / GB2312, current one highlighted) — both directions switch immediately for this session only. The saved session config is left untouched: the same session keeps its current charset across reconnects, and reopening the session falls back to the saved value. Existing garbled text is not retro-fixed; output after the switch decodes with the new charset.

## Command mode

With no terminals open, the empty pane is a command screen; with terminals open, `Ctrl + Shift + P` summons a fullscreen palette anytime. Type `help`, `/?` or `/` to list every command (the idle prompt carries this hint), `↑↓` to select, `Tab` to complete the selected row, `Enter` to run; on an empty prompt, `↑↓` walks the history of commands you already ran; after a command name and a space, `↑↓` walks just that command's arguments (subcommands) — recall and `Enter` re-runs. Commands that take arguments (`/ls`, `/help`) expand an argument catalog after the command name and a space — same `↑↓` select, `Tab` complete, `Enter` run; a typo or two still lands on the nearest match (`sesion` → `sessions`). Doc tabs opened from the command screen (`/ls` inventories, the `/help` manual) render inline in the empty pane's output area: the doc above, the prompt below — the keyboard stays with the command screen; clicking doc content (links, toolbar buttons, a parked tab's ✕) never takes the focus off the prompt, so you can read and type the next command.

| Command | Action |
|---------|--------|
| `/help [chinese / english]` | Open this manual; the argument forces the language (defaults to the UI language) |
| `/?` | Print all commands with their descriptions into the output area (title and total count on the first line; subcommands hang under their command on tree threads (`├`/`└`) with the argument words lit in the accent color; same as the `help` and `/` entries named by the idle hint) |
| `/new` | New connection (opens the session dialog) |
| `/ls [section]` | Inventory of everything: sessions, agents, variable sets, workspaces, and plugins, shown as a doc tab; click a name to open that item (sessions / agents / workspaces launch, variable sets open the editor), with a "new" action in every section. Pass a section to scope to one kind: `/ls env`, `/ls claude` (available: sessions / agents / env / dsh / codex / claude / plugins / all; each scope is its own tab) |
| `/local` | Quick-open a local terminal |
| `/sessions` `/agents` `/dsh` `/codex` `/claude` `/env` `/plugins` `/web` `/settings` | Switch to the matching left panel |

## Session management

- **Pin** — hover a session card, click 📌
- **Search** — filter by name / host / tag / user
- **Groups** — sessions fold into groups; protocol filters (SSH / Telnet / serial) too
- **Float window** — `Ctrl + \`` from anywhere in the app; search and Enter to connect
- **Export / Import** — button at the bottom of the sidebar; AES-256-CBC encrypted, covers sessions and quick commands

## Quick commands

The quick-command strip at the bottom of the session panel: right-click → **Edit groups**, add commands like `tail -f /var/log/syslog` (multi-line and `\n` / `\xHH` escape parsing supported). `Ctrl + F1`–`F12` fires them from anywhere — even with the sidebar collapsed — into the active terminal. Up to 12 commands × 5 groups; the color dots switch groups.

## File manager

SSH sessions only — make sure the active tab is an SSH connection.

- **Browse** — the file panel is the remote directory tree, with glob filtering (`*.log` etc.)
- **Upload** — drag from the desktop onto the file panel
- **Download** — double-click a remote file, or right-click → Download; auto MD5 verification on completion
- **History** — records file, size, path, MD5; supports re-download
- **Transport** — an independent SSH connection that never blocks the terminal; SFTP or TCP-over-SSH tunnel, no plaintext fallback even when `AllowTcpForwarding` is disabled
- **Download directory** — defaults to `~/Downloads/LyShell/`, changeable in settings; optional per-server subdirectory archiving

## Document tabs

Read documents as tabs inside terminal panes, side by side with terminals.

- **Opening** — drag-drop a `.md` / `.html` file onto the window, `Ctrl + Shift + O`, `Ctrl + click` a path inside a terminal, or double-click a remote document in the file tree
- **Formats** — `.md` / `.markdown` / `.txt` render as Markdown (code highlighting); `.html` / `.htm` render in a read-only sandbox
- **Outline rail** — headed Markdown gets a table-of-contents rail; resizable, collapsible
- **Zoom** — `Ctrl + scroll`, click the percentage to reset
- **Hand tool** — toolbar button to drag-pan the view (Markdown also pans on middle-drag anytime)
- `/help` opens exactly this kind of tab

## Web tabs

The left-rail **Web** panel is a light built-in browser, perfect for dashboards and docs. Type a URL (no scheme → `https://` is prepended), press Enter, and it opens as a regular tab in the active split pane — same drag-to-split and tab semantics as terminals, so a dashboard can sit next to the terminal that feeds it.

- **Recent** — successfully loaded URLs are remembered (deduplicated, 30 most recent) and offered as native autocomplete; click to reopen, ✕ to delete one
- **Safety** — only `http` / `https` pass; webview navigation and popups route through a dedicated partition in the main process

## AI Agents

The agent launcher is agent-agnostic — no lock-in. Any CLI tool can be registered: name, command, icon, working directory, env vars. Launching runs it in a **transient terminal** with full scrollback, splits, and IME support; close the tab and it's gone.

An agent can bind to an env profile (next section) so credentials stay centralized.

## DeepSeek Harness workspaces

`dsh`, `codex`, and `claude` are first-class in the Harness panel: dedicated left-rail tabs, per-agent workspace lists, dependency detection.

### Workspaces

A workspace = a directory + a config. Set the model (passed as `--model` on launch), a note, and either a bound env profile or "follow the enabled one". Claude workspaces add a skip-permissions switch (launches with `--dangerously-skip-permissions`).

### Worktree isolation

Point multiple agents at the same repository without stomping each other: flip a workspace to worktree isolation and it launches inside a dedicated git worktree at `<repo>/.lyshell-worktrees/<key>` on branch `lyshell/<key>` — created on first launch, reused ever after, so **uncommitted changes survive restarts**. Deleting the workspace never deletes its worktree.

- **Private (default)** — a readable key is auto-generated (e.g. `claude-myapp-20260708-160745`); each workspace gets its own checkout
- **Shared** — set the key explicitly; workspaces sharing a key share one checkout and one branch, across dsh / codex / claude, seeing each other's edits live

### Launching

- **Terminal TUI** — `dsh-tui` etc. run as a standard terminal tab
- **Embedded Web UI** — spawned as `dsh web --port 0`; LyShell parses the real port and renders it in an in-app `<webview>` tab, loopback-locked and URL-validated
- Both can run **side by side**: drag the Web UI tab to a pane edge; drag back to the center to remount

### Dependency detection

CLI dependencies are detected once at app startup (all three agents in parallel) and cached. When something is missing, the panel names it, gives a one-line install command and repo links — it never installs for you. **Re-detect** forces a fresh scan; PATH is read live from the registry, so a freshly installed CLI needs no restart.

## Env profiles

Pre-configure named `KEY = VALUE` sets for agents and workspaces: enter secrets once, switch environments without touching each workspace.

- **Global single choice** — at most one profile is enabled; click the enabled one to deactivate, falling back to the system environment
- **Core fields** — Base URL and API Key inject per agent mapping: dsh → `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`, codex → `OPENAI_BASE_URL` / `OPENAI_API_KEY`, claude → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
- **Extra variables** — anything else (`CODEX_HOME`, `NO_PROXY`, …) injects verbatim
- **codex quirk** — before launch, `OPENAI_BASE_URL` is written into `$CODEX_HOME/config.toml` (the Rust codex CLI ignores the env var); a line-surgical, idempotent, atomic edit with a one-time `.bak` backup
- **Masking** — secret-looking values (`*_KEY`, `*_TOKEN`, …) are masked by default; the eye toggle reveals one

## MCP integration

LyShell runs a built-in MCP server, letting external AI clients like Claude Code drive terminals over MCP: list sessions, send commands, read output, transfer files, manage connections.

### Registration

Three ways, pick one: ① generic JSON — add to any MCP client's `mcpServers` (or hand it to your agent); ② Claude Code — run the command below in a terminal; ③ Codex — append the TOML below to `~/.codex/config.toml`. The primary config uses LyShell's own binary (no Node.js install needed); use the fallback (requires system Node.js) if it fails. Most of the time you configure nothing by hand: launch an agent from the Agent panel and ask it to register LyShell as its own MCP server.

<!-- lyshell:mcp-register -->

Field reference — `command`: the program that launches the MCP server (LyShell's bundled binary, no Node.js needed); `args`: startup arguments for command, i.e. the mcpServer.js path; `LYSHELL_USER_DATA`: LyShell's data dir, lets the script reach the main app for port & auth; `ELECTRON_RUN_AS_NODE`: run the Electron binary in pure Node mode.

### Tools and capabilities

| Capability | Tools |
|------------|-------|
| `read` | `list_sessions` · `read_output` · `read_file` · `stat_file` · `list_files` · `read_session_notes` · `wait_for_prompt` · `tail_until` |
| `interactiveWrite` | `send_input` · `send_and_wait` |
| `execute` / `localExecute` | `execute_command` (SSH only) · `run_on_sessions` (broadcast, max 50 sessions, concurrency 10) |
| `fileWrite` | `upload_file` · `download_file` |
| `sessionControl` | `create_session` · `reconnect_session` · `close_session` · `open_connection_dialog` |
| `sessionMetadataWrite` | `write_session_notes` |

### Security

- **Per-session authorization** — each terminal gets its own scoped permission; global and session tokens are separate
- **Capability gates** — enforced server-side on every endpoint
- **Shared PTY locking** — while MCP owns a terminal, human input is blocked and the tab is marked
- **Audit panel** — full MCP activity trail, opened as a tab; calendar picker + filters + pagination

Both security toggles below take effect immediately — click a link to flip it:

- **Confirm destructive commands before execution** — {{MCP_TOGGLE_CONFIRM_DESTRUCTIVE}}: shows a confirmation dialog for likely-catastrophic commands: `rm -rf /`, dd to block devices, mkfs, fork bombs, shutdown/reboot, chmod on root. Applies equally to LyShell-spawned terminals (session token) and external MCP clients — the last human gate against prompt-injection triggering disastrous operations
- **Allow MCP to write session notes** — {{MCP_TOGGLE_ALLOW_METADATA_WRITE}}: only affects external MCP clients (global token): when enabled they can read/write summary, usage notes, and tags. Terminals spawned by LyShell itself can always read/write session notes, unaffected by this toggle; creating/reconnecting sessions requires the separate session-control capability

> Known limitation: full-screen TUI apps (vim, htop, less) are not supported over MCP — ANSI stripping garbles alternate-screen sequences. Use LyShell's native terminal.

## Plugins & Python scripting

### Plugin system

A permission-gated host for **Python** (one-shot / persistent) and **Node.js** (persistent) plugins, installable from a local directory, ZIP, or remote URL. Each plugin runs under its own scoped authorization — granular permissions (read / write / execute / file / session control) validated server-side, with path safety, destructive-command confirmation, and shared-terminal locking. Ready-to-run examples live in the repo's `examples/` directory.

### Python engine

An embedded Python engine with the `LyShell` API for terminal automation:

```python
session = LyShell.get_current_session()
LyShell.execute("ls -la")
LyShell.send("hello\n")
LyShell.wait_for("prompt$")
```

Scripts can read `LYSHELL_SESSION_ID`, `LYSHELL_SESSION_TYPE`, `LYSHELL_HOST`, `LYSHELL_PORT` from the environment. The interpreter is auto-detected from PATH and configurable in settings. For long-running or scheduled tasks, prefer Node.js plugins.

## Themes

Instant switching, no restart.

| Theme | Style | Mode |
|-------|-------|------|
| Graphite | Deep graphite + tungsten amber (default) | Dark |
| Slate | Blue-tinted slate, amber accent | Dark |
| Carbon | Neutral charcoal, no blue cast | Dark |
| Ember | Warm walnut brown + warm amber | Dark |
| Paper | Edge-style light: cool gray chrome + white canvas | Light |
| Lark | Feishu-style light: brand-blue accent | Light |

**Custom**: pick a background and accent color; LyShell builds a complete harmonious theme.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + \`` | Session float window |
| `Ctrl + F` | Terminal search |
| `Ctrl + F1` ~ `F12` | Quick command 1–12 |
| `Ctrl + Shift + H` / `V` | Horizontal / vertical split |
| `Ctrl + Shift + P` | Fullscreen command palette |
| `Ctrl + Shift + O` | Open a local document |
| `Alt + 1…9` | Switch left panels |
| Right-click | Paste |
| Middle-click | Terminal search |

## Settings highlights

- **Terminal** — font size applies live; buffer lines and cursor style apply to new sessions
- **Downloads** — default download directory, per-server subdirectory option
- **MCP** — registration configs & security toggles live in this manual's *MCP integration* section
- **Appearance** — theme, language (中文 / English)
- **Python** — custom interpreter path

## Config files

JSON files stored under `%APPDATA%\lyshell\`:

`sessions.json` · `preferences.json` · `quickCommands.json` · `agents.json` · `download-history.json` · `download-config.json` · `mcp-server.json`

Reset everything: delete those files and restart. Sessions and quick commands support encrypted export / import.

## FAQ

**Garbled Chinese characters over SSH?**
Edit the session and switch the encoding from UTF-8 to GBK or GB2312.

**Serial port produces no output?**
Verify port + baud rate → check no other program holds it → some devices need an Enter to activate.

**File manager not showing?**
SSH sessions only. Make sure the active tab is an SSH connection.

**Ctrl+\` float window not working?**
The shortcut is window-level (it never hijacks other apps) — make sure LyShell has focus.

**Where do downloads go?**
Default `~/Downloads/LyShell/`, changeable in settings.
