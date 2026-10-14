# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working with PetLink

You have a work assistant named **PetLink**. It receives tasks and returns results through plain text. It can read text files, execute commands, and modify files, handling analysis, planning, writing, implementation, and validation. **It cannot read or interpret images, or view, click, or operate graphical interfaces.** Handle those tasks yourself, then provide the relevant findings to PetLink as text.

Follow these rules until the user's goal is complete:

1. **Break down the work before delegating.** Divide the task into actionable, verifiable steps with clear dependencies and ownership. Delegate in dependency order, providing the goal, necessary context, file paths, scope, and acceptance criteria. Specify whether PetLink should analyze, propose a solution, or execute the work.

2. **Use files for lengthy content.** Send short instructions directly as text. Use Markdown files for long explanations and language-specific source files or snippet files for code. Provide accessible paths to existing files. Ask PetLink to save lengthy results to files and return their paths with a brief summary.

3. **Choose the best execution path and parallelize when useful.** Compare your capabilities, efficiency, and reliability with PetLink's, then choose the approach most likely to complete the goal efficiently and reliably. Assign critical-path steps to whoever is better suited to handle them. Parallelize only when the expected time savings outweigh the coordination costs. **PetLink runs one task at a time — a `submit` sent while a task is running is silently dropped, never queued.** You may advance your own independent work while that one task runs. Define file and resource ownership to prevent interference. Dependent steps must wait until their prerequisites pass acceptance checks.

4. **Verify before moving on.** Ask PetLink to report the actions performed, files changed, validation results, and remaining issues. Inspect its outputs and handle visual and interface checks yourself. Give specific correction instructions when needed, then proceed once the step meets its acceptance criteria. Do not treat a claim of completion as proof.

5. **Wait quietly when idle.** When no independent work can advance, use an available waiting mechanism until PetLink responds. Avoid repeated analysis, frequent polling, and status updates that contain no new information. Resume when feedback arrives.

6. **Own the final delivery.** Integrate the outputs and perform end-to-end validation to confirm that they satisfy the user's goal. Report what was completed, how it was validated, and any unresolved issues. Provide files and accessible links for lengthy content. Report work as complete only after it has been implemented and appropriately verified.

7. **Open a fresh PetLink session at a real boundary.** Use `kind:'new'` (with `workspace`) to create one, or `kind:'select'` to pin an existing one, when the goal is unrelated to the session's current thread, when you cross into an independent phase, or when the session context has grown too long. Do not just send another `submit` into a dirty session: **`status: idle` means "no task is running", not "clean context."** Call `new`/`select` before `submit` whenever the task depends on a specific working directory — `config.workspace` is only the initial cwd and may drift. Save necessary outputs first, then hand over only the goal, essential context, confirmed conclusions, relevant file paths, remaining work, and acceptance criteria. Do not copy the full conversation history. Keep tightly coupled follow-ups (a fix and its re-verify) in the same session to avoid unnecessary switching.

### Calling PetLink

PetLink is a separate Electron app in the sibling `AIPet/` repo. Its work channel is that app's local integration server at `127.0.0.1:31517` — `POST /api/work/request` with `Authorization: Bearer <integrationToken>` (copy from its Panel「接入接口」; CLI: `AIPET_TOKEN`), or the UI channel: `GET /ui/handshake` → `uiToken` → WS `/?ui=<uiToken>` with a whitelisted `Origin` → `ui.req work.request`. Local scripts count as trusted UI; the token is DPAPI-encrypted at rest, so read it from the UI, not the file. Submit `{kind:'submit',text,requestId}`, poll `state` to `idle`/`error` (reply lands in `entries`/`transcript`), answer approvals with the real `id`/`optionId` from `state.approvals` — no auto-approve. One task at a time; `cancel` will not retract commands already sent to a shell; `config.workspace` is only the initial cwd (pin a directory with `select`/`new`). Execution is DeepSeek Harness's agent loop. **Task-message shape, lifecycle, and the constraints actually hit in practice: `AIPet/docs/calling-petlink.md`** (agent contract — read it before delegating). Protocol surface: `AIPet/docs/harness-work-mode.md`. When the AIPet LyShell plugin is enabled, PetLink may share LyShell's Harness backend (`AIPet/docs/lyshell-shared-harness.md`) and drive this app's sessions through its own work tools — those tool calls arrive as real terminal/session actions here.

## Project

LyShell — Electron + React + xterm.js terminal app supporting SSH, Telnet, serial, and local PTY connections, with a built‑in SFTP file manager, quick commands, AI Agent launchers, a Python scripting engine, a sandboxed plugin system, Harness/dsh/codex agent workspaces, and an MCP HTTP API for external tooling.

Stack: Electron 28, TypeScript 5, React 18, xterm.js, node-pty, ssh2, serialport, Zustand, TailwindCSS, electron-vite.

## Commands

```bash
npm install              # install deps; postinstall (scripts/postinstall.cjs) rebuilds native modules for the Electron 28 ABI — full rebuild on node 18/20 LTS, ConPTY-only on Windows + node 24 (node-pty 1.0.0's winpty target can't compile there)
npm run pack             # build + unpacked dir (no installer)
npm run rebuild          # rebuild native modules (serialport, node-pty) for current Electron ABI — required after Electron upgrades or fresh installs on a new machine
npm run dev              # electron-vite dev (renderer HMR + main reload)
npm run typecheck        # tsc --noEmit for both renderer and node configs
npm run lint             # eslint src --ext .ts,.tsx
npm run lint:fix
npm run test             # vitest run
npm run test:watch
npx vitest run path/to/file.test.ts   # single test file
npm run build            # electron-vite build → dist/
npm run dist:win | dist:mac | dist:linux   # build + electron-builder package
npm run clean            # remove dist/ and release/
```

Build output goes to `dist/` (loaded by Electron); installers go to `release/`.

## Architecture

Electron three-process layout, plus child processes for the stdio MCP server and plugin hosts (see `electron.vite.config.ts` for the exact build inputs and aliases):

- **Main** (`src/main/`, alias `@main`) — Node side. Six bundle entry points: `index.ts` (app bootstrap), `file/download-worker.ts` / `file/upload-worker.ts` (SFTP transfer Workers), `mcp-server/index.ts` (stdio MCP server child process), `plugin-host/index.ts` (shared Node plugin host child process), and `plugin-host/oneshot.ts` (one-shot plugin task runner). Externalizes `electron-log`, `node-pty`, `koffi`, `serialport`, `better-sqlite3`, `ssh2` so they load as native modules at runtime.
- **Preload** (`src/preload/`) — two bundles: `index.ts` bridges IPC into the renderer via `contextBridge`; `plugin-view.ts` is the sandboxed guest preload for plugin webviews and exposes only `window.lyshellView`. The renderer never imports Node APIs directly; sandbox + contextIsolation are on.
- **Renderer** (`src/renderer/`, alias `@`) — React 18 + Tailwind, mounted via `index.html` (plus `scroll-art-preview.html` for the scroll-art preview window). Manual chunks split out `xterm`, `react`, and a `vendor` bundle.
- **Shared** (`src/shared/`, alias `@shared`) — types and constants used by both sides. Always import shared session/file/pane/plugin types from here, never duplicate.

### Connection layer

`src/main/connectors/` defines `BaseConnector` (an EventEmitter subclass) with concrete `SSHConnector`, `TelnetConnector`, `SerialConnector`, `LocalConnector` implementations. `src/main/terminal/session-manager.ts` (the `sessionManager` singleton) owns the lifecycle of every session, dispatching to the right connector by `ConnectionType` and wrapping each one with an `OutputBuffer` that tracks raw and ANSI-stripped output for `read_output` / `send_and_wait`.

Adding a new protocol means: subclass `BaseConnector`, register it in `connectors/index.ts`, extend the `SessionConfig` union in `@shared/types`, and add a branch in `session-manager.ts`.

### IPC

The main app renderer→main API is registered in `src/main/ipc/handlers.ts` and validates input via `src/main/ipc/validation.ts`. The handler is invoked from `main/index.ts` at app start. When you add an IPC channel, also expose it in `src/preload/index.ts` and the matching renderer store/hook. Plugin guests use `src/preload/plugin-view.ts` (`window.lyshellView`) and dedicated `plugin:view-*` IPC handlers in `src/main/plugin/view-bridge.ts`; main verifies the registered guest identity and permissions, and proxies API tool calls through the HTTP API.

### MCP integration

LyShell exposes its sessions to external MCP clients in two layers:

- `src/main/mcp/http-server.ts` runs an HTTP API on `127.0.0.1` at a random port inside the main process. It writes the port + auth tokens to a port file (`mcp-server.json` under userData) and gates each endpoint by capability (`read` / `interactiveWrite` / `execute` / `localExecute` / `fileWrite` / `sessionControl`) using `mcp/auth.ts`. Token kind determines capability set — see commit `93c86e6` for the per-session token model.
- `src/main/mcp-server/` is a separate child process bundled as `dist/main/mcpServer.js`. It speaks MCP over stdio to a client (e.g. Claude Code) and proxies tool calls into the local HTTP API via `http-client.ts`. Tool definitions live in `tools.ts`.

Per-session tokens are injected into spawned PTYs via env (`LYSHELL_MCP_ENV` constant). Treat any HTTP/MCP input as untrusted — validation is enforced server-side.

**MCP known limitations (by design):**
- Full-screen TUI apps (vim, htop, less, gdb TUI) are not supported over `send_and_wait` / `read_output` — the MCP layer reads the raw PTY stream and strips ANSI, so alternate-screen control sequences render as garbled text. These tools are scoped to line-oriented programs. Interact with full-screen apps via the real terminal in the LyShell UI, not MCP.
- Destructive-command confirmation (B1) scans a single `send_input` / `execute_command` / `send_and_wait` payload; it cannot catch a destructive command assembled across multiple calls. The `deniedSessionIds` / capability toggles are the backstop.
- Set `LYSHELL_MCP_HIDE_DEPRECATED=1` in the MCP server's env to hide legacy non-`lyshell_`-prefixed tool aliases from `tools/list` (old names still work via `ALIAS_TO_NEW`).

### Plugin system

Plugins ship a manifest (`@shared/plugin-types`, API surface in `@shared/plugin-api`). Node plugins run in child processes (`src/main/plugin-host/`, bundles `pluginHost` / `pluginHostOneshot`) spawned with `ELECTRON_RUN_AS_NODE=1`; they call main's HTTP API through `mcp-server/http-client.ts`. Per-plugin tokens (`bindPluginToken` in `mcp/auth.ts`) carry the granted capabilities and travel to the Node host over IPC. Python plugins run in separate per-plugin processes through `src/main/python/engine.ts`, with only that plugin's token injected via env. Consumer plugins without a main entry need no runtime process. `src/main/plugin/` owns install/host lifecycle (`host-mgr.ts`, `install-zip.ts`), webview guests and their protocol (`view-*.ts`), and resource teardown (`resource-registry.ts`, `process-cleanup.ts`); disable/uninstall invariants are in `docs/plugin-resource-lifecycle.md`. Plugin UI views are sandboxed `<webview>`s using preload `plugin-view.ts` under a per-plugin partition; `main/index.ts` gates their attach, navigation and `window.open`.

### Agent workspaces (Harness / dsh / codex)

`src/main/harness/` launches and configures DeepSeek Harness CLIs. `src/main/dsh/` bridges a Harness run back into LyShell (`bridge.ts` patches a `dsh-bridge` package with a shared handshake key) and manages its web workbench child processes. `src/main/codex/` holds Codex base-url presets. Shared types live in `@shared/harness.ts` and `@shared/worktree.ts`. PetLink can share this same Harness backend (see the PetLink section and `docs/petlink-shared-harness.md`).

### File transfers

`src/main/file/` has a queue (`download-queue.ts`) and Worker pools (`download-worker-manager.ts`, `upload-worker-manager.ts`) that fan out to the worker bundles built from `download-worker.ts` / `upload-worker.ts`. Workers use `ssh-file-client.ts` (SFTP via `ssh2`) with an `exec.ts` fallback. The main window reference is set on startup so workers can post progress events back to the renderer; `cleanupAllWorkers` / `cleanupAllUploadWorkers` are called on app quit.

### Storage

`src/main/storage/` — repositories built on JSON files under `app.getPath('userData')`. AI Agent definitions, env profiles and Harness workspaces use atomic tmp+rename writes; preferences, sessions, quick commands and transfer history still write directly, while plugin and MCP audit repositories fall back to direct writes if rename fails. There is no SQLite (the `better-sqlite3` external is reserved for future use). `repository.ts` covers preferences/sessions/quick commands; `agent-repository.ts` covers AI Agent definitions; `download-history.ts` covers transfer history; `plugin-repository.ts`, `env-profile-repository.ts`, `harness-workspace-repository.ts` and `mcp-audit-repository.ts` cover plugins, env profiles, Harness workspaces and the MCP audit log.

### Renderer state

Zustand stores in `src/renderer/stores/`:

- `session-store` — known sessions + connection metadata.
- `terminal-store` — open xterm instances, attach/detach to connectors via IPC events.
- `pane-store` — split layout (the recursive split tree under `components/Layout/SplitPaneContainer.tsx`) plus tab/overlay state (`overlay-kinds.ts`, `workbench-detail.ts`).
- `file-store` / `transfer-store` — file manager state and transfer queue mirror.
- `theme-store` / `locale-store` / `ui-store` — theme, i18n locale, general UI chrome.
- `plugin-store` / `quick-commands-store` — installed plugins and quick commands.

Re-export everything from `stores/index.ts`; don't import individual files outside the stores folder.

### Window & security model

`main/index.ts` creates a frameless `BrowserWindow` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: true`. Navigation and `window.open` are locked down to the dev server origin or the local `index.html`. Webview guests (web tabs and plugin views) get the same `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true` / `webSecurity: true` lockdown, with per-plugin partitions and subframe navigation gating (`webview-frame-navigation.ts`). SSH/connection-related uncaught exceptions are intentionally suppressed from showing dialogs (see the `process.on('uncaughtException')` block) — but in `NODE_ENV=development` the process exits on any other uncaught error so bugs aren't swallowed.

## Conventions

- Cursor blink is off by default for performance; the helper is `isCursorBlinkEnabled` in `@shared/constants` (see `1ffe1da`). **Do not load `WebglAddon`** — it was tried and removed because it breaks IME candidate positioning (xterm's `.xterm-helper-textarea` stops tracking the cursor and the candidate window drifts). The default DOM renderer is fast enough.
- Comments in this codebase are predominantly Chinese — match the surrounding style when editing existing files. New code in fresh files can use either, but be consistent within a file.
- When touching IPC, always update: handler in `main/ipc/handlers.ts`, validator in `main/ipc/validation.ts`, preload bridge in `src/preload/index.ts`, and the consuming store/hook.
- Path aliases (configured in `electron.vite.config.ts` and `tsconfig.json`): `@main`, `@shared`, `@preload`, `@` (renderer). Use them instead of long relative paths.
- Deeper notes live under `docs/`: `mcp-config.md` (tool/capability matrix), `plugin-resource-lifecycle.md` (disable/uninstall invariants), `terminal-content-api.md` (screenshot vs `read_output`), `petlink-shared-harness.md`.
