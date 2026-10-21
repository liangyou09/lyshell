# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working with LyShell

Use **LyShell's native DeepSeek Harness work channel** as your work assistant. It receives tasks and returns results through plain text, and can read text files, execute commands, and modify files for analysis, planning, writing, implementation, and validation. **It cannot interpret images or view, click, or operate graphical interfaces.** Handle those tasks yourself and pass the relevant findings as text.

Follow these rules until the user's goal is complete:

1. **Break down the work before delegating.** Define actionable, verifiable steps with dependencies and ownership. Delegate in dependency order, including the goal, necessary context, absolute file paths, scope, acceptance criteria, and whether the assistant should analyze, propose, or execute.

2. **Use files for lengthy content.** Send short instructions directly as text. Put long explanations in Markdown and code in language-specific source or snippet files. Ask the assistant to save lengthy results to files and return their paths with a brief summary.

3. **Choose the best execution path and parallelize when useful.** Compare your capabilities, efficiency, and reliability with the assistant's. Assign critical-path work to whoever is better suited. You may advance independent work while a delegated task runs; define file/resource ownership to prevent interference. **Each client credential has one active native task.** Busy submissions are explicitly rejected, not queued for later execution. Wait for prerequisites to pass acceptance checks before dependent steps.

4. **Verify before moving on.** Require a report of actions performed, files changed, validation results, and remaining issues. Inspect the actual outputs and handle visual/interface checks yourself. Give specific corrections when needed. A completion claim is not proof.

5. **Wait quietly when idle.** Use an available waiting mechanism when no independent work can advance. Poll state at about four-second intervals when necessary; avoid frequent polling and updates without new information.

6. **Own the final delivery.** Integrate the outputs and perform end-to-end validation. Report what was completed, how it was validated, unresolved issues, and accessible output files. Claim completion only after implementation and appropriate verification.

7. **Start a fresh session at a real boundary.** Use `kind:'new'` with an existing absolute `workspace` directory for unrelated goals, independent phases, or excessive context. Use `kind:'select'` only for a session created by the same credential in the current backend. **Idle does not mean clean context.** Before work that depends on a directory, create/select a session and verify the returned `sessionId` and `workspace`; pass absolute paths in task messages. Hand over only the goal, essential context, confirmed conclusions, relevant paths, remaining work, and acceptance criteria. Keep tightly coupled fixes and their re-verification in the same session.

8. **Keep code review exclusively with the primary coding agent.** Personally read and review all code changes, including delegated changes. Never delegate code review, in whole or in part, to the LyShell work assistant, PetLink, subagents, or third parties. Verify potential issues and provide your own findings and final judgment. This rule takes precedence over delegation and parallelization rules.

### Calling LyShell

Read the native work contract before delegating: **`D:/workspace/claude/LyShell/docs/native-harness-work.md`** (use the corresponding file in the current LyShell checkout when working elsewhere). Execution uses the official DeepSeek Harness agent loop; LyShell owns transport, task state, session ownership, and approval routing.

- **MCP:** use `lyshell_harness_work` with a request object containing `kind`.
- **HTTP:** `POST /api/harness/work/request` and `GET /api/harness/work/state` on LyShell's random loopback MCP port, authenticated with `x-lyshell-token`. Requests and MCP calls share the same state. HTTP replies use `{success,data,error?}`; inspect `data` for work state.
- **Connection:** prefer the `LYSHELL_MCP_PORT` / `LYSHELL_MCP_TOKEN` injected into a LyShell-launched local terminal/Agent. External programs need the existing external-MCP setting and its port-file connection package. Read operations require read access; external mutations require both local execution and file-write access. Keep credentials in memory/headers, never in task text, logs, or URLs.
- **Session:** call `{kind:'new',workspace:'<existing absolute directory>'}` or `{kind:'select',sessionId:'<owned session>'}` before submitting. `targets` lists only sessions created by this credential in the current backend. Do not attempt to select PetLink, arbitrary Web history, or another credential's sessions.
- **Submit:** `{kind:'submit',sessionId,text,requestId}`; provide a unique nonempty `requestId` (at most 128 characters) and nonempty text (at most 32000 characters). Include goal, scope, context, absolute paths, acceptance criteria, and analysis/proposal/execution mode in the task text.
- **Track:** capture the backend `identity` and returned `acceptedTaskId`, then poll `{kind:'state'}`. Acceptance is not completion. Success requires the same backend instance, session, and task, with `taskState:'completed'`. Results are in `transcript`; `transcriptTruncated` indicates bounded output, so request file-based deliverables for long results.
- **Approvals:** pending items are in `approvals`. Reply with `{kind:'approve',id,optionId}` using the real ID and an option from that item's `options` (`allowed-once`, `rejected`, or `cancelled`). **Never automatically approve.** Present the pending approval to the user and wait for their decision.
- **Stop:** `{kind:'cancel',taskId}` applies only to that current running task; continue polling for the official terminal state. Accepted/unconfirmed tasks that have not entered a turn cannot be reported as cancelled. Cancellation does not retract shell commands already dispatched.
- **Disconnect:** `{kind:'disconnect'}` is allowed only when no task is active; it releases the current selection and native backend lease, without deleting history or stopping the shared backend.
- **Failure:** `failed`, `cancelled`, `unconfirmed`, and `offline` are not success. Timeout or transport failure may occur after acceptance: read authoritative state and **never blindly resubmit**. Request deduplication is bounded and in-memory, not cross-restart exactly-once. Backend restart loses native control ownership.
- **PetLink coexistence:** native tasks use independent credentials, sessions, approvals, and leases; PetLink release/disable/uninstall must not cancel them. Plugin host/UI credentials cannot access the native work API. Programs sharing one global token are one caller; distinct terminal credentials are isolated. Use the native channel directly rather than the PetLink integration server at port 31517. If unavailable, check the running LyShell build and connection settings and report the limitation; do not silently fall back to PetLink or restart a shared backend.

## Project

LyShell — Electron + React + xterm.js terminal app supporting SSH, Telnet, serial, and local PTY connections, with a built‑in SFTP file manager, quick commands, AI Agent launchers, a Python scripting engine, a sandboxed plugin system, Harness/dsh/codex agent workspaces, and an MCP HTTP API for external tooling.

Stack: Electron 43 (Chromium 150), TypeScript 5, React 18, xterm.js, node-pty 1.1 (Node-API), ssh2, serialport, Zustand, TailwindCSS, electron-vite. Development requires Node.js 22.12 or later.

## Commands

```bash
npm install              # install deps; postinstall verifies native modules in the pinned Electron runtime, rebuilding when needed (Node.js >=22.12)
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

`src/main/harness/` launches and configures DeepSeek Harness CLIs. `src/main/dsh/` bridges a Harness run back into LyShell (`bridge.ts` loads the owned `dsh-bridge` package with a host-only handshake key) and manages its web workbench child processes. `dsh/work.ts` exposes the native work channel through `/api/harness/work/*` and the `lyshell_harness_work` MCP tool; its contract and request validation live in `@shared/harness-work.ts`. The bridge keeps native callers' sessions/tasks/approvals separate from PetLink's existing control binding while sharing the official backend. See `docs/native-harness-work.md` for native control and `docs/petlink-shared-harness.md` for plugin coexistence. `src/main/codex/` holds Codex base-url presets. Shared workspace types live in `@shared/harness.ts` and `@shared/worktree.ts`.

### File transfers

`src/main/file/` uses serial transfer chains and Worker managers (`download-worker-manager.ts`, `upload-worker-manager.ts`) that run the bundles built from `download-worker.ts` / `upload-worker.ts`. Built-in file operations and both transfer Workers use SFTP only, with no EXEC/Python/Base64 fallback. Other transfer methods live in the installable `examples/legacy-transfer` plugin. Ordinary SSH commands use independent `ssh-command-executor.ts` / `ssh-command-shell.ts` channels without probing SFTP. The main window reference is set on startup so workers can post progress events back to the renderer; `cleanupAllWorkers` / `cleanupAllUploadWorkers` are called on app quit.

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
- Deeper notes live under `docs/`: `native-harness-work.md` (native assistant contract), `mcp-config.md` (tool/capability matrix), `plugin-resource-lifecycle.md` (disable/uninstall invariants), `terminal-content-api.md` (screenshot vs `read_output`), `petlink-shared-harness.md` (PetLink coexistence).
