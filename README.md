# LyShell

A cross-platform terminal application supporting SSH, Telnet, serial, and local PTY connections — with a built-in SFTP file manager, quick commands, AI Agent launchers, a Python scripting engine, a plugin system, and an MCP HTTP API for external tooling.

Built on Electron 28 + React 18 + xterm.js.

<p align="center">
  <img src="resources/icon.png" alt="LyShell" width="128" />
</p>

---

## Table of Contents

- [Features](#features)
- [Usage Guide](#usage-guide)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Development](#development)
- [Architecture](#architecture)
- [Connection Types](#connection-types)
- [Terminal](#terminal)
- [Split Panes & Tabs](#split-panes--tabs)
- [Quick Commands](#quick-commands)
- [File Manager](#file-manager)
- [AI Agents](#ai-agents)
- [Plugin System](#plugin-system)
- [Python Scripting](#python-scripting)
- [MCP Integration](#mcp-integration)
- [Float Window](#float-window)
- [Internationalization](#internationalization)
- [Themes](#themes)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Build & Package](#build--package)
- [FAQ](#faq)
- [License](#license)

---

## Features

| Category | Details |
|----------|---------|
| **Multi-protocol** | SSH, Telnet, serial port, local PTY — all in one window |
| **Split panes** | Arbitrary horizontal/vertical splits with drag-to-split, tab swapping, and layout persistence |
| **Quick commands** | Grouped shortcut bar with Ctrl+F1–F12 keybindings |
| **File manager** | Built-in SFTP/SSH file browser with upload/download, progress tracking, and MD5 verification |
| **AI Agents** | One-click launch for Claude Code, Aider, Copilot CLI, and custom agents |
| **Plugin system** | Capability-gated plugin host, per-plugin tokens, dev install UI, ZIP/URL install |
| **Python engine** | Embedded Python scripting with a terminal automation API |
| **MCP API** | Full Model Context Protocol server over stdio + HTTP, with audit logging and per-session tokens |
| **Float window** | Global hotkey (Ctrl+Alt+F) quick-connect overlay |
| **i18n** | Chinese (zh) and English (en) with i18next |
| **Themes** | Light/dark themes with a unified `--terminal-bg` token system |
| **Data security** | AES-256-CBC encrypted export for sensitive session data |
| **Window persistence** | Window size, position, and split layout remembered across restarts |

---

## Usage Guide

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Title Bar  │  Tabs (session tabs × N)          │ ⚙ — ✕ │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  Activity  │                                             │
│  Rail      │          Terminal / Split Panes             │
│  (sidebar) │                                             │
│            │                                             │
│  ┌───────┐ │                                             │
│  │Session│ │                                             │
│  │ List  │ │                                             │
│  │       │ │                                             │
│  │  🔍   │ │                                             │
│  │       │ │                                             │
│  │ sess1 │ │                                             │
│  │ sess2 │ │                                             │
│  │ sess3 │ │                                             │
│  │  ...  │ │                                             │
│  └───────┘ │                                             │
│  ┌───────┐ │                                             │
│  │ Agent │ │                                             │
│  │ Quick │ │                                             │
│  │Launch │ │                                             │
│  └───────┘ │                                             │
│  ┌───────┐ │                                             │
│  │ File  │ │                                             │
│  │ Panel │ │                                             │
│  └───────┘ │                                             │
├────────────┴─────────────────────────────────────────────┤
│  Quick Commands Bar  │  Cols×Rows  │  Status             │
└──────────────────────────────────────────────────────────┘
```

| Area | What it does |
|------|-------------|
| **Activity Rail** | Switch between Sessions, Agents, File Manager, and Plugins panels |
| **Session List** | All saved sessions — click to connect, right-click for context menu, drag to pin/reorder |
| **Agent Quick Launch** | One-click launch for AI coding tools (Claude Code, Aider, etc.) |
| **File Panel** | Remote file browser (SSH only) — browse, upload, download |
| **Terminal Area** | The main terminal canvas — supports split panes, tabs, and drag-to-split |
| **Quick Commands Bar** | Configurable shortcut buttons at the bottom — click to run, Ctrl+F1–F12 to trigger |
| **Status Bar** | Terminal dimensions (click to toggle), connection status, encoding indicator |
| **Title Bar** | Gear icon for settings, MCP audit panel access, float window toggle |

---

### First Launch Walkthrough

#### 1. Create Your First SSH Session

1. Click the **+** button at the top of the session list, or press `Ctrl+Alt+F` to open the float window
2. Select **SSH** as the connection type
3. Fill in:
   - **Name** — a friendly label (e.g. "Production Web")
   - **Host** — server IP or hostname (e.g. `192.168.1.100`)
   - **Port** — defaults to `22`
   - **Username** — your SSH user
   - **Password** or **Private Key** — authentication
4. Click **Connect** — the terminal opens in a new tab

> 💡 **Tip**: Use the **Summary** and **Tags** fields to document each session. Tags like `prod-env`, `database-server`, `bastion` help you filter later.

#### 2. Configure Startup Commands

For sessions that need initialization after login, edit the session and add **Startup Commands** — one per line:

```
cd /var/log/myapp
export NODE_ENV=production
```

These execute sequentially after the SSH handshake completes.

#### 3. Quick Connect Anytime

Press `Ctrl+Alt+F` from any application to bring up the float window. Search for a session by name or host, press Enter to connect instantly.

---

### Daily Workflows

#### Multi-Server Monitoring (Split Panes)

```
┌──────────────────┬──────────────────┐
│  Web Server      │  DB Server       │
│  $ tail -f       │  $ htop          │
│  /var/log/nginx  │                  │
├──────────────────┴──────────────────┤
│  Jump Host                          │
│  $ ssh internal-box                 │
└─────────────────────────────────────┘
```

1. Click a saved session to open it in the first pane
2. Press `Ctrl+Shift+V` to split vertically
3. Click another session — it opens in the new pane
4. Press `Ctrl+Shift+H` to split horizontally
5. Drag the dividers to adjust ratios

The layout is saved automatically and restored on restart.

#### Log Tailing with Quick Commands

1. Right-click the quick commands bar → **Edit Group**
2. Add commands for the current group:
   - `tail -f /var/log/syslog` → "Syslog"
   - `tail -f /var/log/nginx/access.log` → "Nginx"
   - `journalctl -fu sshd` → "SSH"
3. Switch between servers by clicking their tabs, then click the command button or press `Ctrl+F1`/`Ctrl+F2`/`Ctrl+F3`

Create separate groups for different server roles — "Web Tier" commands on one group, "DB Tier" on another.

#### File Transfer

**Upload** — drag a file from your desktop or file explorer onto the File Panel

**Download** — double-click a remote file in the File Panel, or right-click → Download

**Track progress** — the status bar shows active transfers with speed and ETA. Completed downloads get an MD5 checksum for verification.

#### AI Agent in Context

1. Navigate to a project directory in your local terminal
2. Click an Agent button in the sidebar (e.g. Claude Code)
3. A new terminal tab opens with the AI tool launched in that directory
4. The Agent session is transient — close the tab and it's gone, no session list pollution

#### Python Automation

```python
# Save as check_servers.py, run via the Python panel
import time

sessions = LyShell.list_sessions(tag="prod-env")
for s in sessions:
    LyShell.connect(s.id)
    LyShell.wait_for("$")
    LyShell.execute("uptime")
    LyShell.execute("df -h /")
    print(f"--- {s.name} done ---")
```

Open the Python panel from the Activity Rail, paste or load your script, and execute — it drives the terminal automatically.

---

### Session Management

| Action | How |
|--------|-----|
| **Pin a session** | Hover over the session card → click 📌 |
| **Clone a session** | Double-click the tab's left half |
| **Clone channel** (SSH, no re-auth) | Double-click the tab's right half |
| **Search sessions** | Type in the search box above the session list |
| **Edit a session** | Right-click the session → ✏️, or hover → click ✏️ |
| **Export sessions** | Click the import/export button in the session list header |
| **Tag & filter** | Add tags when creating/editing — filter by tag in the search box |

### Terminal Tips

- **Select text** → automatically copied to clipboard
- **Right-click** → paste
- **Middle-click** → open search bar
- **Ctrl+F** → search within terminal output (supports regex and all-tabs mode)
- **Encoding issues** → edit the session and switch between UTF-8 / GBK / GB2312
- **Resize** → the status bar shows current terminal dimensions; click to toggle cols×rows display

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 18 (LTS 18 or 20 recommended — node-pty 1.0.0 cannot compile on Node 24)
- **Python 3** (for node-gyp native module compilation)
- **Windows**: Visual Studio Build Tools ("Desktop development with C++" workload)
- **macOS**: Xcode Command Line Tools
- **Linux**: `build-essential`, `libx11-dev`, and related packages

### Install & Run

```bash
git clone https://github.com/lyshell/lyshell.git
cd lyshell
npm install          # installs deps; postinstall rebuilds native modules on Node 18/20
npm run rebuild      # rebuild native modules (serialport, node-pty) for current Electron ABI
npm run dev          # start in development mode with HMR
```

---

## Installation

Download the latest installer from [Releases](https://github.com/lyshell/lyshell/releases).

| Platform | Format | Architecture |
|----------|--------|--------------|
| Windows | NSIS installer (.exe) + portable | x64 |
| macOS | DMG | x64 + arm64 |
| Linux | AppImage + .deb | x64 |

Auto-update is supported via `electron-updater` on all platforms.

---

## Development

```bash
npm install              # install dependencies
npm run rebuild          # rebuild native modules for current Electron ABI
npm run dev              # electron-vite dev (renderer HMR + main reload)
npm run dev:no-mcp       # dev mode with MCP server disabled
npm run typecheck        # tsc --noEmit for both renderer and node configs
npm run lint             # eslint src --ext .ts,.tsx
npm run lint:fix         # auto-fix lint issues
npm run test             # vitest run
npm run test:watch       # vitest in watch mode
npx vitest run path/to/file.test.ts  # single test file
```

---

## Architecture

LyShell follows the standard Electron three-process model:

```
┌──────────────────────────────────────────────────────┐
│  Renderer Process (React 18 + TailwindCSS + xterm)   │
│  sandbox: true, contextIsolation: true               │
│  No Node.js access — IPC only via preload bridge     │
├──────────────────────────────────────────────────────┤
│  Preload (contextBridge)                              │
│  Exposes typed IPC channels to the renderer          │
├──────────────────────────────────────────────────────┤
│  Main Process (Node.js)                               │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐ │
│  │Connectors│ │ Session  │ │  MCP   │ │  Plugin   │ │
│  │SSH/TELNET│ │ Manager  │ │ HTTP   │ │   Host    │ │
│  │SERIAL/LCL│ │          │ │ Server │ │           │ │
│  └──────────┘ └──────────┘ └────────┘ └───────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │  File    │ │  Python  │ │      Storage         │ │
│  │Transfers │ │  Engine  │ │  (JSON file repos)   │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
├──────────────────────────────────────────────────────┤
│  Child Processes                                     │
│  ┌────────────────┐ ┌─────────────────────────────┐ │
│  │Download Worker │ │  MCP Server (stdio child)    │ │
│  │Upload Worker   │ │  Speaks MCP to external      │ │
│  │(SFTP transfer) │ │  clients, proxies to HTTP    │ │
│  └────────────────┘ └─────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### State Management

Zustand stores in the renderer process:

| Store | Responsibility |
|-------|---------------|
| `session-store` | Known sessions + connection metadata |
| `terminal-store` | Open xterm instances, attach/detach to connectors via IPC |
| `pane-store` | Recursive split-tree layout |
| `file-store` | File manager state |
| `transfer-store` | Transfer queue and progress |
| `theme-store` | Theme switching (light/dark) |
| `locale-store` | Language preference (zh/en) |
| `plugin-store` | Installed plugins and their status |

### Path Aliases

Configured in `electron.vite.config.ts` and `tsconfig.json`:

| Alias | Path |
|-------|------|
| `@main` | `src/main/` |
| `@shared` | `src/shared/` |
| `@preload` | `src/preload/` |
| `@` | `src/renderer/` |

---

## Connection Types

### SSH

Built on the `ssh2` library. Supports password and private key authentication, keepalive, custom shell entry commands (sent sequentially after login), and configurable timeouts.

**Session cloning:**
- **Double-click tab left side** — clone session (new SSH connection, re-authenticates)
- **Double-click tab right side** (SSH only) — clone channel (shares the existing SSH connection, no re-auth)

### Telnet

Raw TCP socket with full Telnet protocol support (IAC negotiation).

### Serial

Built on `serialport`. Supports configurable baud rate, data bits, stop bits, and parity. Auto-detects available COM ports on the system.

### Local

Built on `node-pty`. Opens a local shell (cmd.exe / bash / zsh / PowerShell) inside the app with configurable working directory and environment variables.

---

## Terminal

Powered by xterm.js 5.5 with WebGL addon for GPU-accelerated rendering.

### Features

- **Search**: Ctrl+F or middle-click to open the search bar. Supports regex, case-sensitive matching, and cross-tab search.
- **Scrollback**: Configurable 1,000–100,000 lines.
- **Encoding**: Per-session charset — UTF-8 (default), GBK, GB2312.
- **Startup commands**: Per-session command sequences auto-executed after connection.
- **Selection**: Auto-copy on selection; right-click to paste.
- **IME**: CJK composition handled via a CompositionHelper monkey-patch for correct candidate positioning.
- **Cursor blink**: Off by default for performance; toggleable in settings.

### Tab Status Indicators

- 🟢 **Green** — Connected
- 🔴 **Red** — Connection error
- ⚪ **Gray** — Disconnected
- 🔵 **Blue highlight** — Inactive tab has new output

---

## Split Panes & Tabs

### Split Operations

| Action | Shortcut |
|--------|----------|
| Horizontal split | `Ctrl + Shift + H` |
| Vertical split | `Ctrl + Shift + V` |
| Drag tab to pane edge | Split (blue = split, green = reverse, orange = swap) |
| Drag divider | Resize split ratio (10%–90%) |

Split layouts persist across restarts via localStorage.

### Tab Operations

- Click to switch
- Double-click to clone/reconnect
- Drag to reorder within a pane or move between panes
- × to close

---

## Quick Commands

A shortcut bar in the status bar for one-click command execution in the active terminal.

- **Left-click** a command button to execute
- **Right-click** to edit
- **Double-click empty area** to add a new command
- **Ctrl+F1–F12** to trigger commands 1–12 in the current group

Commands are organized into up to 5 named, color-coded groups of 12 commands each. Three preset groups (System Admin, Network Tools, Log Viewer) ship by default.

---

## File Manager

Embedded in the sidebar, available for SSH sessions only.

### Capabilities

- SFTP-based browsing with automatic fallback to SSH exec mode
- Drag-and-drop upload from the local filesystem
- Double-click to download remote files
- Right-click context menu: download, delete, rename, new directory
- Independent SSH connection for file operations (never blocks the terminal)

### Transfer Engine

- Worker-thread pool for concurrent uploads/downloads
- Real-time progress and speed display
- Automatic MD5 checksum on download completion
- TCP-over-SSH tunnel with token handshake when SFTP is unavailable
- Secure: no plaintext fallback when `AllowTcpForwarding` is disabled

### Download History

Persistent history with filename, remote path, local path, file size, timestamp, status, and MD5. Supports re-download and open-local-file actions.

---

## AI Agents

A quick-launch bar for AI coding tools, located in the sidebar below the search box.

### Built-in Agents

| Agent | Command | Icon |
|-------|---------|------|
| Claude Code | `claude` | Claude brand icon |
| Aider | `aider` | 🤝 |
| Copilot CLI | `gh copilot` | 🐙 |

### Custom Agents

Each agent is configurable with:
- **Name** — display name
- **Command** — shell launch command
- **Icon** — emoji picker or brand icon (auto-matched by command name)
- **Working directory** — native folder picker
- **Environment variables** — extra env vars injected at launch

Agent sessions are transient — they never leak into the persistent session list. Click an agent to launch it in a new local terminal with the configured command, working directory, and environment.

---

## Plugin System

LyShell includes a capability-gated plugin host. Plugins run in a dedicated child process that connects back to the main process via HTTP API, sandboxed behind per-plugin tokens with fine-grained capability toggles.

### Installation Methods

- **Local dev install** — point to a plugin directory for development
- **ZIP install** — import a packaged plugin archive
- **URL install** — fetch and install from a remote URL

### Security Model

Each plugin receives its own MCP token scoped to granted capabilities only. The capability gate (`read` / `interactiveWrite` / `execute` / `fileWrite` / `sessionControl`) is enforced server-side on every call. Multi-layer security checks include path safety validation, destructive-command confirmation, and shared PTY locking to prevent MCP and human input from colliding.

### Plugin API

Plugins can:
- List, read, and interact with sessions
- Execute commands and send terminal input
- Access the file manager
- Spawn controlled processes via `spawnControlled` API

See `docs/plugin-system-design.md` for the full API reference.

---

## Python Scripting

LyShell embeds a Python execution engine for terminal automation.

### LyShell API

```python
# Get current session info
session = LyShell.get_current_session()

# Execute a command in the current terminal
LyShell.execute("ls -la")

# Send raw data to the terminal
LyShell.send("hello\n")

# Wait for a specific output pattern
LyShell.wait_for("prompt$")
```

### Injected Environment Variables

| Variable | Description |
|----------|-------------|
| `LYSHELL_SESSION_ID` | Current session ID |
| `LYSHELL_SESSION_TYPE` | Session type (ssh/telnet/serial/local) |
| `LYSHELL_HOST` | Connection host |
| `LYSHELL_PORT` | Connection port |

Python path defaults to the bundled portable Python in `resources/`, falling back to the system PATH.

---

## MCP Integration

LyShell exposes its sessions and capabilities to external MCP clients through two layers:

### Architecture

```
External MCP Client (e.g. Claude Code)
        │ stdio (MCP protocol)
        ▼
┌───────────────────┐
│  MCP Server       │  Child process (dist/main/mcpServer.js)
│  (stdio → HTTP)   │  Proxies MCP tool calls to the local HTTP API
└───────┬───────────┘
        │ HTTP (127.0.0.1, random port)
        ▼
┌───────────────────┐
│  HTTP API Server  │  Inside the main process
│  + Auth + Audit   │  Gates each endpoint by capability
└───────────────────┘
```

### Tools

| Tool | Capability | Description |
|------|-----------|-------------|
| `list_sessions` | `read` | List sessions in the sidebar |
| `send_input` | `interactiveWrite` | Send text to an interactive terminal |
| `send_and_wait` | `interactiveWrite` | Send input and capture the terminal response |
| `execute_command` | `execute` | Run a command via exec channel (SSH only) |
| `run_on_sessions` | `execute` | Broadcast a command across multiple sessions |
| `read_output` | `read` | Read recent terminal output |
| `upload_file` / `download_file` | `fileWrite` | SFTP file transfer |
| `read_file` / `stat_file` / `list_files` | `read` | Remote file system inspection |
| `create_session` | `sessionControl` | Create or reuse a saved session |
| `reconnect_session` | `sessionControl` | Reconnect a dropped connection |
| `read_session_notes` / `write_session_notes` | `read` / `sessionMetadataWrite` | Manage per-session metadata |
| `close_session` | `sessionControl` | Close a session's terminal connection, preserving the saved session |
| `open_connection_dialog` | `sessionControl` | Open the new connection dialog for interactive credential entry |
| `wait_for_prompt` | `read` | Wait for a shell prompt or regex pattern |
| `tail_until` | `read` | Poll output until a pattern matches |

### Security

- **Per-session tokens**: Each PTY spawned by MCP receives its own scoped token via environment variable
- **Capability gates**: Every endpoint enforces the caller's capabilities
- **Destructive-command confirmation**: Scans `send_input` / `execute_command` / `send_and_wait` payloads for known destructive patterns
- **Shared PTY locking**: Prevents MCP and human input from colliding in the same terminal
- **Audit logging**: All MCP calls are logged with timestamp, tool, session, and result
- **Audit panel**: Real-time activity log with calendar picker, filtering, and pagination, accessible from the title bar

### Limitations (by design)

- Full-screen TUI apps (vim, htop, less, gdb TUI) are not supported over `send_and_wait` / `read_output` — the MCP layer strips ANSI, so alternate-screen sequences render as garbled text. Use the real terminal in the LyShell UI for interactive TUIs.
- Destructive-command confirmation scans a single payload; it cannot catch a destructive command assembled across multiple calls. Use the capability toggle as the backstop.

---

## Float Window

A lightweight quick-connect overlay invoked with `Ctrl+Alt+F` (global shortcut, works from any application).

### Features

- Search and quick-connect to saved sessions
- View pinned sessions and recent connections
- Create new sessions
- Collapsible to a thin sidebar strip that expands on hover

### Configurable Behaviors

- Position (four corners or custom)
- Opacity
- Auto-close after execution, connection, or focus loss
- Hover-to-expand mode
- Default tab (Sessions / Commands / History)

---

## Internationalization

LyShell uses `i18next` with `react-i18next` for UI localization. Currently supported:

- **zh** — Simplified Chinese
- **en** — English

Language preference is persisted in the locale store. The framework is wired into all renderer components; adding a new language requires only a translation JSON bundle.

---

## Themes

LyShell uses a `[data-theme]` attribute on the root element for theme switching, with a unified `--terminal-bg` CSS custom property that propagates to all terminal surfaces (canvas, tabs, MCP audit panel).

### Light Theme
| Element | Color |
|---------|-------|
| Foreground | `#333333` |
| Background | `#FFFFFF` |
| Cursor | `#333333` |

### Dark Theme (default)
| Element | Color |
|---------|-------|
| Foreground | `#CCCCCC` |
| Background | `#0C0C0C` |
| Cursor | `#FFFFFF` |

Both themes include full ANSI 16-color palettes. Terminal colors are resolved at runtime based on luminance and hot-updated when the theme changes — no restart required.

### Application Chrome

| Element | Dark | Light |
|---------|------|-------|
| Main background | `#1E1E1E` | `#F3F3F3` |
| Secondary background | `#252526` | `#FFFFFF` |
| Card background | `#2D2D30` | `#E8E8E8` |
| Accent | `#0078D4` | `#0078D4` |

---

## Keyboard Shortcuts

### Global

| Shortcut | Action |
|----------|--------|
| `Ctrl + Alt + F` | Toggle float window |

### Terminal

| Shortcut | Action |
|----------|--------|
| `Ctrl + F` | Open terminal search |
| `Ctrl + F1` ~ `Ctrl + F12` | Execute quick command 1–12 |
| Right-click | Paste clipboard |
| Middle-click | Open search bar |

### Split Panes

| Shortcut | Action |
|----------|--------|
| `Ctrl + Shift + H` | Horizontal split |
| `Ctrl + Shift + V` | Vertical split |

---

## Configuration

All configuration is stored as JSON files under the user data directory:

| File | Contents |
|------|----------|
| `sessions.json` | All saved session configurations |
| `preferences.json` | User preferences |
| `quickCommands.json` | Quick command groups and entries |
| `agents.json` | AI Agent definitions |
| `download-history.json` | File transfer history |
| `download-config.json` | Download directory settings |
| `mcp-server.json` | MCP server port and auth tokens |

### User Data Locations

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\lyshell\` |
| macOS | `~/Library/Application Support/lyshell/` |
| Linux | `~/.config/lyshell/` |

### Export / Import

Session configurations and quick commands can be exported to JSON with optional AES-256-CBC encryption. Import supports password-protected files with a preview-and-confirm workflow.

---

## Project Structure

```
src/
├── main/                    # Main process (Node.js)
│   ├── index.ts             # App bootstrap, BrowserWindow creation
│   ├── connectors/          # Connection protocol implementations
│   │   ├── base.ts          # BaseConnector (EventEmitter)
│   │   ├── ssh.ts           # SSHConnector (ssh2)
│   │   ├── telnet.ts        # TelnetConnector (raw TCP + IAC)
│   │   ├── serial.ts        # SerialConnector (serialport)
│   │   └── local.ts         # LocalConnector (node-pty)
│   ├── terminal/            # Session manager, output buffer
│   ├── ipc/                 # IPC handler registration + validation
│   ├── file/                # SFTP client, transfer Workers, path safety
│   ├── mcp/                 # HTTP API server, auth, destructive checks
│   ├── mcp-server/          # Stdio MCP child process (tools, HTTP client)
│   ├── plugin/              # Plugin host, capability gate, API routes
│   ├── plugin-host/         # Plugin process management
│   ├── python/              # Python engine integration
│   ├── storage/             # JSON file repositories
│   └── types/               # Main-process-only types
├── preload/                 # Preload script
│   └── index.ts             # contextBridge IPC exposure
├── renderer/                # Renderer process (React)
│   ├── index.html           # Entry HTML
│   ├── App.tsx              # Root component
│   ├── components/          # React components
│   │   ├── Layout/          # SplitPaneContainer, SessionsPanel, ActivityRail
│   │   ├── Terminal/        # TerminalView, search, tabs
│   │   ├── FileManager/     # FilePanel, transfer UI
│   │   ├── QuickCommands/   # Status bar command bar
│   │   ├── FloatWindow/     # Quick-connect overlay
│   │   ├── SessionDialog/   # Create/edit session dialogs
│   │   └── ExportImportDialog/
│   ├── stores/              # Zustand stores
│   └── styles/              # Tailwind + global CSS
└── shared/                  # Shared types and constants
    └── types/               # Session, file, pane, IPC channel types
```

---

## Build & Package

```bash
npm run build              # electron-vite build → dist/
npm run build:no-mcp       # build without MCP server
npm run dist:win           # build + package for Windows (NSIS + portable)
npm run dist:mac           # build + package for macOS (DMG)
npm run dist:linux         # build + package for Linux (AppImage + .deb)
npm run clean              # remove dist/ and release/
```

Build output goes to `dist/` (loaded by Electron); installers go to `release/`.

To disable the MCP feature at build time, use the `:no-mcp` variants or set `LYSHELL_DISABLE_MCP=true`.

---

## FAQ

### SSH shows garbled Chinese characters?

Edit the session and switch the encoding from UTF-8 to GBK or GB2312.

### Serial port has no output?

1. Verify the COM port and baud rate are correct
2. Check that no other program is using the port
3. Some devices require pressing Enter to activate output

### File manager is not visible?

The file manager is only available for SSH sessions. Make sure the active tab is an SSH connection.

### Native modules fail to compile on Windows?

Install Visual Studio Build Tools with the "Desktop development with C++" workload, then run `npm run rebuild`. If `electron-builder install-app-deps` fails due to a newer Visual Studio version, compile manually with `npx node-gyp`:

```bash
ELECTRON_VERSION=$(node -p "require('./node_modules/electron/package.json').version")

npx node-gyp rebuild --directory=node_modules/cpu-features \
  --target=$ELECTRON_VERSION --arch=x64 --dist-url=https://www.electronjs.org/headers

npx node-gyp rebuild --directory=node_modules/@serialport/bindings-cpp \
  --target=$ELECTRON_VERSION --arch=x64 --dist-url=https://www.electronjs.org/headers

cd node_modules/node-pty && npx node-gyp rebuild \
  --target=$ELECTRON_VERSION --arch=x64 --dist-url=https://www.electronjs.org/headers && cd ../..
```

### How do I reset all configuration?

Delete all `.json` files in the user data directory and restart the app.

### Global shortcut Ctrl+Alt+F doesn't work?

It may be taken by another application. The float window shortcut can be reconfigured in LyShell settings.

---

## License

Proprietary © 2026 liangyou. See the End-User License Agreement (`resources/licenses/LyShell-LICENSE.txt`).

---

<p align="center">
  <a href="https://github.com/lyshell/lyshell">GitHub</a> ·
  <a href="https://github.com/lyshell/lyshell/issues">Issues</a> ·
  <a href="https://github.com/lyshell/lyshell/releases">Releases</a>
</p>
