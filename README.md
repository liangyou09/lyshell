<p align="center">
  <img src="https://img.shields.io/badge/LyShell-v1.0.3-0078D4?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/license-Freeware-orange?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/MCP-ready-FF6B6B?style=flat-square" alt="mcp">
</p>

# 💻 LyShell

> 🔌 **Your terminal, now AI's terminal too.** LyShell is a Windows terminal with a built-in MCP server — letting Claude Code and other AI clients drive your SSH / Telnet / serial / local PTY sessions directly. Plus AI Agent launcher, plugin system, and Python scripting.

**English** | [简体中文](README.zh.md)

[✨ Highlights](#-highlights) · [🔗 MCP](#-mcp-integration) · [🤖 AI Agents](#-ai-agents) · [🧩 Plugins](#-plugin-system--python-scripting) · [🚀 Quick Start](#-quick-start) · [❓ FAQ](#-faq)

---

## ✨ Highlights

| | |
|---|---|
| 🔗 **MCP Server** — Expose your terminals to Claude Code and other AI clients, with per-session authorization and audit log | 🤖 **Agent Launcher** — Run Claude Code, Aider, Copilot CLI, or any custom CLI in a clean transient terminal |
| 🧩 **Plugin System** — Extend with Python or Node.js plugins, each running under granular permissions | 🐍 **Python Engine** — Script terminal automation through a built-in `LyShell` API |

---

<p align="center">
  <img src="docs/assets/screenshot-main.jpg" alt="LyShell main interface" width="80%">
</p>

---

## 📥 Install

Download the latest portable build from [Releases](https://github.com/liangyou09/lyshell_release/releases) — **no installation needed**, just download and run.

| Platform | Format | Architecture | Requirements |
|----------|--------|--------------|--------------|
| 🪟 Windows | Portable (.exe) | x64 | Windows 10 / 11, 64-bit |

> 🚧 Currently **Windows only** — macOS and Linux builds are not yet available.

---

## 🔗 MCP Integration

**This is what makes LyShell different.** It serves as an MCP server, letting external AI clients like Claude Code control terminals via the MCP protocol — listing sessions, sending commands, reading output, transferring files, and managing connections.

> 📖 **Configuration** — see [MCP Configuration](docs/mcp-config.md). In most cases you don't configure anything by hand: launch an agent from the **Agent Launcher** and ask it to configure LyShell as its MCP server itself. Registration configs are emitted in **JSON / CLI / TOML** to fit different clients.

### Tools

| Tool | Capability | Description |
|------|-----------|-------------|
| `list_sessions` | `read` | List sidebar sessions |
| `send_input` | `interactiveWrite` | Send text, autoNewline support |
| `send_and_wait` | `interactiveWrite` | Send and capture response, strips echo + ANSI |
| `execute_command` | `execute` / `localExecute` | Run via independent exec channel (SSH only) |
| `run_on_sessions` | `execute` / `localExecute` | Broadcast command, max 50 sessions, concurrency 10 |
| `read_output` | `read` | Read N lines of terminal output |
| `upload_file` / `download_file` | `fileWrite` | SFTP file transfer |
| `read_file` / `stat_file` / `list_files` | `read` | Remote file inspection, recursive + glob |
| `create_session` | `sessionControl` | Create/reuse saved session, auto-dedup by target |
| `reconnect_session` | `sessionControl` | Reconnect dropped connection |
| `close_session` | `sessionControl` | Disconnect without deleting the saved session |
| `open_connection_dialog` | `sessionControl` | Open the new-connection dialog for user input |
| `read_session_notes` | `read` | Read session summary, notes, tags |
| `write_session_notes` | `sessionMetadataWrite` | Update summary, notes, tags |
| `wait_for_prompt` | `read` | Wait for shell prompt or regex |
| `tail_until` | `read` | Poll output until pattern matches |

### Security

- 🔑 **Per-session authorization** — each terminal gets its own scoped permission
- 🚪 **Capability gates** — enforced server-side on every endpoint
- 🛡️ **Destructive-command check** — scans for `rm -rf`, `dd if=`, fork bombs
- 🔒 **Shared PTY locking** — MCP vs human input never collide
- 📊 **Audit panel** — calendar + filter + pagination, accessible from the title bar

> ⚠️ Full-screen TUI apps (vim, htop, less) are not supported over MCP — ANSI stripping garbles alternate-screen sequences. Use the LyShell UI native terminal instead.

<p align="center">
  <img src="docs/assets/screenshot-mcp-audit.jpg" alt="MCP audit panel" width="80%">
</p>

---

## 🤖 AI Agents

Agent-agnostic terminal — no lock-in to any AI tool. Launch any CLI agent and it runs in a regular terminal with full scrollback, split panes, and IME support.

| Agent | Command |
|-------|---------|
| 🧠 Claude Code | `claude` |
| 🤝 Aider | `aider` |
| 🐙 Copilot CLI | `gh copilot` |

**Custom agents**: Any CLI tool can be registered — name, command, icon, working directory, env vars. Sessions are transient: close the tab, it's gone.

<p align="center">
  <img src="docs/assets/screenshot-agents.jpg" alt="AI Agent launcher" width="80%">
</p>

---

## 🧩 Plugin System & Python Scripting

### Plugins

Permission-gated host for **Python** (one-shot / persistent) and **Node.js** (persistent) plugins. Install from local directory, ZIP, or remote URL. Each plugin runs with its own scoped authorization — granular permissions (read / write / execute / file / session control) with path safety, destructive-command confirmation, and shared-PTY locking.

> ⚠️ Plugins activate on startup (`onStartup`) today. Event-based activation and declarative UI contributions are not wired up yet.

📦 Ready-to-run examples in [`examples/`](examples/).

### Python Engine

Embedded Python with `LyShell` API for terminal automation:

```python
session = LyShell.get_current_session()
LyShell.execute("ls -la")
LyShell.send("hello\n")
LyShell.wait_for("prompt$")
```

Environment variables: `LYSHELL_SESSION_ID` · `LYSHELL_SESSION_TYPE` · `LYSHELL_HOST` · `LYSHELL_PORT`.

Python path auto-detected from system PATH, configurable in settings.

> 💡 For long-running or scheduled tasks, consider **Node.js plugins** via the [Plugin System](#-plugin-system--python-scripting) — they're a better fit.

---

## 🚀 Quick Start

### First Connection
1. Click **+** at the top of the session list → **SSH**
2. Fill in host, port, username, password/private key
3. Click **Connect** — tab turns 🟢 green

> 💡 For network devices needing `shell` → `enable`, add those in **Shell Enter Commands** — LyShell sends them sequentially.

### Quick Connect
`Ctrl+Alt+F` from any app → search → Enter to connect.

<p align="center">
  <img src="docs/assets/screenshot-float-window.jpg" alt="Float window quick connect" width="60%">
</p>

### Multi-Server Monitoring
Click a session → `Ctrl+Shift+V` to split vertically → click another session. Layout auto-saves.

### File Transfer
- **Upload** — drag from desktop to File Panel
- **Download** — double-click remote file or right-click → Download
- **Progress** — real-time speed + ETA, auto MD5 on completion
- **History** — file, size, path, MD5 recorded; supports re-download
- **Security** — independent SSH connection (never blocks terminal), SFTP or TCP-over-SSH tunnel; no plaintext fallback even when `AllowTcpForwarding` is disabled
- **Download directory** — default `~/Downloads/LyShell/`, optional auto-create server subdirectory for archiving

### Quick Commands
Right-click the quick commands bar → **Edit Group** → add commands like `tail -f /var/log/syslog`. Trigger with `Ctrl+F1`–`F12`. Up to 12 commands × 5 groups.

### Session Management
- 📌 Pin — hover card → click 📌
- 📋 Clone session — double-click tab left half
- ⚡ Clone channel (no re-auth) — double-click tab right half (SSH only)
- 🔍 Search — type name/host/tag in search box

### Terminal Tips
- Select text → auto-copy · Right-click → paste · Middle-click → search bar
- `Ctrl+F` → in-terminal search (regex, case-sensitive, cross-tab)
- Encoding issues → edit session, switch UTF-8 / GBK / GB2312
- Click `cols × rows` in status bar → clear screen
- Click buffer count → scroll to bottom; double-click → clear scrollback

---

## 🔌 Connection Types & Terminal

| Type | Key params | Notes |
|------|-----------|-------|
| 🖥️ **SSH** | password or private key; port `22` | Post-login commands, keepalive; dual-click clone |
| 📟 **Telnet** | host + port `23` | Full IAC negotiation |
| 🔌 **Serial** | COM port, baud `115200` (9600–921600), 8N1 | Auto-detects ports |
| 💻 **Local PTY** | cmd.exe / PowerShell | Configurable working directory + env |

**Terminal**: GPU-accelerated rendering, full ANSI + 256 colors. Scrollback up to 100,000 lines. Split panes (horizontal/vertical), drag-to-split. Quick commands bar `Ctrl+F1–F12`. Tab status: 🟢 Connected · 🔴 Error · ⚪ Disconnected · 🔵 New output.

---

## 🎨 Themes

5 presets + custom. Instant switch, no restart.

| Theme | Style | Mode |
|-------|-------|------|
| **Graphite** | Deep graphite + tungsten amber (default) | Dark |
| **Slate** | Blue-tinted slate, amber accent | Dark |
| **Carbon** | Neutral charcoal, no blue cast | Dark |
| **Ember** | Warm walnut brown + warm amber | Dark |
| **Paper** | Natural warm paper, graphite ink | Light |

**Custom**: pick a background and accent color, LyShell auto-builds a complete harmonious theme.

<p align="center">
  <img src="docs/assets/screenshot-theme-comparison.jpg" alt="Theme presets and custom color picker" width="80%">
</p>

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Alt + F` | Toggle float window |
| `Ctrl + F` | Terminal search |
| `Ctrl + F1` ~ `F12` | Quick command 1–12 |
| `Ctrl + Shift + H` | Horizontal split |
| `Ctrl + Shift + V` | Vertical split |
| Right-click | Paste |
| Middle-click | Search bar |

---

## ⚙️ Configuration

JSON files in `%APPDATA%\lyshell\`:

`sessions.json` · `preferences.json` · `quickCommands.json` · `agents.json` · `download-history.json` · `download-config.json` · `mcp-server.json`

AES-256-CBC encrypted export/import for sessions and quick commands.

---

## ❓ FAQ

<details>
<summary><b>SSH garbled Chinese characters?</b></summary>
Edit session, switch encoding from UTF-8 to GBK or GB2312.
</details>

<details>
<summary><b>Serial port no output?</b></summary>
Verify port + baud rate → check no other program uses it → some devices need Enter to activate.
</details>

<details>
<summary><b>File manager not showing?</b></summary>
SSH sessions only. Ensure the active tab is an SSH connection.
</details>

<details>
<summary><b>How to reset all configuration?</b></summary>
Delete all JSON files in `%APPDATA%\lyshell\` and restart.
</details>

<details>
<summary><b>Ctrl+Alt+F not working?</b></summary>
May be taken by another app. Reconfigure in LyShell settings.
</details>

<details>
<summary><b>Where are downloaded files?</b></summary>
Default `~/Downloads/LyShell/`. Change in settings.
</details>

---

## 📄 License

LyShell is free to download and use, but the source code is not yet open. **Reverse engineering and redistribution of the binary are not permitted** without prior permission. See [LICENSE](LICENSE).

© 2026 liangyou. All rights reserved.

---

<p align="center">
  <a href="https://github.com/liangyou09/lyshell_release">GitHub</a> ·
  <a href="https://github.com/liangyou09/lyshell_release/issues">Issues</a> ·
  <a href="https://github.com/liangyou09/lyshell_release/releases">Releases</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
