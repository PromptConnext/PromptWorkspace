# Repository Guidelines

## Project Structure & Module Organization

PromptWorkspace is a pnpm workspace (`apps/*`) with a Python backend. Main applications are `engine` (Node/TypeScript orchestration), `desktop` (Tauri/React), `web` (Next.js team UI), and `vscode` (editor extension). TypeScript source lives in each app’s `src/`; cloud code lives in `apps/cloud/app/`. The marketing site moved out to [`PromptConnext/promptconnext-corp-web`](https://github.com/PromptConnext/promptconnext-corp-web).

Cloud migrations live in `apps/cloud/migrations/`; Supabase configuration is in `supabase/`. Desktop icons are in `apps/desktop/src-tauri/icons/`, and extension assets are in `apps/vscode/media/`. Read relevant architecture decisions in `docs/decisions/` before changing subsystem boundaries.

## Build, Test, and Development Commands

Use Node 24+, pnpm 9.11.0, and Python 3.10+ for cloud development. Desktop development also requires Rust/Tauri prerequisites.

- `pnpm install`: install workspace dependencies.
- `pnpm engine`: start the local engine; it runs TypeScript directly without a build step.
- `pnpm desktop`: launch the Tauri application and sidecar.
- `pnpm web`: start Next.js on port 3000.
- `pnpm vscode`: watch-build the extension.
- `pnpm --dir apps/web build`: build the web application; desktop and vscode also provide `build` scripts.
- `pnpm --dir apps/web typecheck`: check TypeScript; engine and vscode also expose `typecheck`.

For cloud, create a virtual environment in `apps/cloud`, run `pip install -r requirements.txt`, then `uvicorn app.main:app --reload --port 8080`.

## Coding Style & Naming Conventions

Match nearby code: TypeScript uses two-space indentation, double quotes, and semicolons; Python uses four spaces and snake_case. Use PascalCase for React components and camelCase for functions/hooks. Run `ruff check .` from `apps/cloud` (100-character lines). Preserve root pnpm React type overrides.

## Testing Guidelines

Run `pnpm --dir apps/engine test`, `pnpm --dir apps/vscode test`, and `pnpm --dir apps/web test` for affected applications. Engine/extension use Node’s test runner; web uses Vitest, Testing Library, and happy-dom. Name tests `*.test.ts` or `*.test.tsx`; web tests sit beside source, engine/extension tests under `test/`. Cloud uses `pytest` from `apps/cloud`, with `tests/test_*.py`. No numeric coverage threshold is configured; add regression coverage for behavior changes.

## Commit & Pull Request Guidelines

Follow scoped Conventional Commits, e.g. `feat(cloud): add deployment template` or `docs(decisions): clarify preview behavior`. Keep commits focused. PRs should explain behavior changes, link relevant issues/ADRs, report validation, and include screenshots for UI changes.

## Security & Configuration

Use app-specific `.env.example` files for setup; never commit credentials. Keep model keys in the established keychain/secret-store paths. Configure the extension through `promptworkspace.*` VS Code settings.
