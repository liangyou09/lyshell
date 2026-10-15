# Codex Instructions

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

8. **Keep code review exclusively with Codex.** Personally read and review all code changes, including delegated changes. Never delegate code review, in whole or in part, to the LyShell work assistant, PetLink, subagents, or third parties. Verify potential issues and provide your own findings and final judgment. This rule takes precedence over delegation and parallelization rules.

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

# Repository Guidelines

LyShell is an Electron 28 + React 18 + TypeScript 5 terminal app for SSH, Telnet, serial, and local PTY connections, with SFTP file management, quick commands, AI Agent launchers, a Python engine, and an MCP HTTP API. `CLAUDE.md` has the full architecture deep dive.

## Project Structure & Module Organization

```
src/
├── main/        # Electron main process (Node): connectors, ipc, file, mcp, storage, terminal, python
├── preload/     # contextBridge IPC bridge (renderer never imports Node APIs directly)
├── renderer/    # React 18 + Tailwind UI: components, hooks, stores, types
└── shared/      # types & constants shared across processes
```

`dist/` holds build output, `release/` packaged installers, `resources/` icons and fonts.

## Build, Test, and Development Commands

- `npm install` — install deps; `postinstall` rebuilds native modules.
- `npm run rebuild` — rebuild `serialport`/`node-pty` for the current Electron ABI (after upgrades or on a fresh machine).
- `npm run dev` — `electron-vite dev` with renderer HMR and main reload.
- `npm run typecheck` — `tsc --noEmit` for renderer and node configs.
- `npm run lint` / `npm run lint:fix` — ESLint over `src` (`.ts`, `.tsx`).
- `npm run test` / `npm run test:watch` — Vitest.
- `npm run build` — build to `dist/`.
- `npm run dist:win` / `dist:mac` / `dist:linux` — build and package installers into `release/`.
- `npm run clean` — remove `dist/` and `release/`.

## Coding Style & Naming Conventions

- TypeScript `strict` mode; `noUnusedLocals`/`noUnusedParameters` enforced — prefix unused args with `_`.
- ESLint (`@typescript-eslint/recommended`, `react`, `react-hooks`): `no-explicit-any` is a warning — prefer explicit types.
- Use path aliases `@`, `@shared`, `@preload`, `@main` (in `tsconfig.json` and `electron.vite.config.ts`) over long relative imports.
- Styling is TailwindCSS; theme tokens live in `tailwind.config.js`.
- Existing comments are predominantly Chinese — match the surrounding file's language and stay consistent within a file.

## Testing Guidelines

- Vitest is wired through `package.json` (no separate config). Run `npm run test` in CI or `npm run test:watch` during development.
- Colocate tests next to the module, named `*.test.ts` (e.g. `src/main/terminal/ansi-stripper.test.ts`).
- Existing Vitest suites cover pure-logic units in src/main/mcp/; extend the same pattern, prioritizing pure functions over IO-heavy code.

## Commit & Pull Request Guidelines

- Conventional Commits in Chinese: `feat:`, `fix:`, `refactor:` — e.g. `feat: 新增本地终端(LocalConnector)与AI Agent功能`. One-line subject, comma-separated detail after a dash if needed.
- When touching IPC, update all four points together: handler (`src/main/ipc/handlers.ts`), validator (`src/main/ipc/validation.ts`), preload bridge (`src/preload/index.ts`), and the consuming store/hook.
- PRs should describe the change, link related issues, and call out any new IPC channels or shared types.

## Security & Configuration

- Renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. Never import Node APIs in the renderer — expose them through the preload bridge.
- Treat all MCP/HTTP input as untrusted; validation is enforced server-side in `src/main/ipc/validation.ts` and `src/main/mcp/auth.ts`.
- Native modules (`serialport`, `node-pty`, `ssh2`) are externalized — run `npm run rebuild` after switching Electron versions.
