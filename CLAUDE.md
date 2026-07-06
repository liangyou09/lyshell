# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LyShell — Electron + React + xterm.js terminal app supporting SSH, Telnet, serial, and local PTY connections, with a built‑in SFTP file manager, quick commands, AI Agent launchers, a Python scripting engine, and an MCP HTTP API for external tooling.

Stack: Electron 28, TypeScript 5, React 18, xterm.js, node-pty, ssh2, serialport, Zustand, TailwindCSS, electron-vite.

## Commands

```bash
npm install              # install deps (postinstall runs electron-builder install-app-deps)
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

Electron three-process layout (see `electron.vite.config.ts` for the exact build inputs and aliases):

- **Main** (`src/main/`, alias `@main`) — Node side. Has four bundle entry points: `index.ts` (app bootstrap), `file/download-worker.ts` and `file/upload-worker.ts` (SFTP transfer Workers), and `mcp-server/index.ts` (a stdio MCP server child process). Externalizes `electron-log`, `node-pty`, `serialport`, `better-sqlite3`, `ssh2` so they load as native modules at runtime.
- **Preload** (`src/preload/index.ts`) — bridges IPC into the renderer via `contextBridge`. The renderer never imports Node APIs directly; sandbox + contextIsolation are on.
- **Renderer** (`src/renderer/`, alias `@`) — React 18 + Tailwind, mounted via `index.html`. Manual chunks split out `xterm`, `react`, and a `vendor` bundle.
- **Shared** (`src/shared/`, alias `@shared`) — types and constants used by both sides. Always import shared session/file/pane types from here, never duplicate.

### Connection layer

`src/main/connectors/` defines `BaseConnector` (an EventEmitter subclass) with concrete `SSHConnector`, `TelnetConnector`, `SerialConnector`, `LocalConnector` implementations. `src/main/terminal/session-manager.ts` (the `sessionManager` singleton) owns the lifecycle of every session, dispatching to the right connector by `ConnectionType` and wrapping each one with an `OutputBuffer` that tracks raw and ANSI-stripped output for `read_output` / `send_and_wait`.

Adding a new protocol means: subclass `BaseConnector`, register it in `connectors/index.ts`, extend the `SessionConfig` union in `@shared/types`, and add a branch in `session-manager.ts`.

### IPC

All renderer→main calls go through `src/main/ipc/handlers.ts` (~1500 LOC, the single registration point) and validate input via `src/main/ipc/validation.ts`. The handler is invoked from `main/index.ts` at app start. When you add an IPC channel, also expose it in `src/preload/index.ts` and the matching renderer store/hook.

### MCP integration

LyShell exposes its sessions to external MCP clients in two layers:

- `src/main/mcp/http-server.ts` runs an HTTP API on `127.0.0.1` at a random port inside the main process. It writes the port + auth tokens to a port file (`mcp-server.json` under userData) and gates each endpoint by capability (`read` / `interactiveWrite` / `execute` / `localExecute` / `fileWrite` / `sessionControl`) using `mcp/auth.ts`. Token kind determines capability set — see commit `93c86e6` for the per-session token model.
- `src/main/mcp-server/` is a separate child process bundled as `dist/main/mcpServer.js`. It speaks MCP over stdio to a client (e.g. Claude Code) and proxies tool calls into the local HTTP API via `http-client.ts`. Tool definitions live in `tools.ts`.

Per-session tokens are injected into spawned PTYs via env (`LYSHELL_MCP_ENV` constant). Treat any HTTP/MCP input as untrusted — validation is enforced server-side.

**MCP known limitations (by design):**
- Full-screen TUI apps (vim, htop, less, gdb TUI) are not supported over `send_and_wait` / `read_output` — the MCP layer reads the raw PTY stream and strips ANSI, so alternate-screen control sequences render as garbled text. These tools are scoped to line-oriented programs. Interact with full-screen apps via the real terminal in the LyShell UI, not MCP.
- Destructive-command confirmation (B1) scans a single `send_input` / `execute_command` / `send_and_wait` payload; it cannot catch a destructive command assembled across multiple calls. The `deniedSessionIds` / capability toggles are the backstop.
- Set `LYSHELL_MCP_HIDE_DEPRECATED=1` in the MCP server's env to hide legacy non-`lyshell_`-prefixed tool aliases from `tools/list` (old names still work via `ALIAS_TO_NEW`).

### File transfers

`src/main/file/` has a queue (`download-queue.ts`) and Worker pools (`download-worker-manager.ts`, `upload-worker-manager.ts`) that fan out to the worker bundles built from `download-worker.ts` / `upload-worker.ts`. Workers use `ssh-file-client.ts` (SFTP via `ssh2`) with an `exec.ts` fallback. The main window reference is set on startup so workers can post progress events back to the renderer; `cleanupAllWorkers` / `cleanupAllUploadWorkers` are called on app quit.

### Storage

`src/main/storage/` — repositories built on JSON files under `app.getPath('userData')`. `repository.ts` covers preferences/sessions/quick commands; `agent-repository.ts` covers AI Agent definitions; `download-history.ts` covers transfer history. There is no SQLite (the `better-sqlite3` external is reserved for future use).

### Renderer state

Zustand stores in `src/renderer/stores/`:

- `session-store` — known sessions + connection metadata.
- `terminal-store` — open xterm instances, attach/detach to connectors via IPC events.
- `pane-store` — split layout (the recursive split tree under `components/Layout/SplitPaneContainer.tsx`).
- `file-store` / `transfer-store` — file manager state and transfer queue mirror.

Re-export everything from `stores/index.ts`; don't import individual files outside the stores folder.

### Window & security model

`main/index.ts` creates a frameless `BrowserWindow` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. Navigation and `window.open` are locked down to the dev server origin or the local `index.html`. SSH/connection-related uncaught exceptions are intentionally suppressed from showing dialogs (see the `process.on('uncaughtException')` block) — but in `NODE_ENV=development` the process exits on any other uncaught error so bugs aren't swallowed.

## Conventions

- Cursor blink is off by default for performance; the helper is `isCursorBlinkEnabled` in the terminal layer (see `1ffe1da`). Use `WebglAddon` for renderer perf.
- Comments in this codebase are predominantly Chinese — match the surrounding style when editing existing files. New code in fresh files can use either, but be consistent within a file.
- When touching IPC, always update: handler in `main/ipc/handlers.ts`, validator in `main/ipc/validation.ts`, preload bridge in `src/preload/index.ts`, and the consuming store/hook.
- Path aliases (configured in `electron.vite.config.ts` and `tsconfig.json`): `@main`, `@shared`, `@preload`, `@` (renderer). Use them instead of long relative paths.
