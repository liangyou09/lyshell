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
