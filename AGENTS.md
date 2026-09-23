# Repository Guidelines

## Project Structure & Module Organization
- `crates/game/` is the main Bevy game crate (`src/` for code, `assets/` for runtime assets).
- `crates/e2e/` contains end-to-end support code and tests (`tests/`).
- `web/` holds the web shell and static assets used by Trunk (entry at `web/index.html`).
- Build and deployment helpers live in `just.ts`, `Trunk.toml`, and `wrangler.jsonc`.

## Build, Test, and Development Commands
- `cargo run -p dinosaur-game` runs the native game in dev mode.
- `cargo build --release` produces an optimized native build.
- `deno task build-wasm` builds the web (WASM) bundle via Trunk into `dist/`.
- `deno task web` installs WASM deps and builds the web bundle (CI-friendly).
- `cargo test --workspace` runs all unit/integration tests.
- `deno run -A just.ts clippy` and `deno run -A just.ts fmt` run Rust linting and formatting checks.
- `deno task lint`, `deno task format`, and `deno task typecheck` check the TypeScript task runner.

## Coding Style & Naming Conventions
- Rust 2021 edition; use `rustfmt` defaults (4-space indentation).
- Prefer `snake_case` for functions/modules, `CamelCase` for types.
- Keep asset filenames lowercase with hyphens (e.g., `crates/game/assets/ground.png`).
- Linting is enforced by `cargo clippy` with warnings treated as errors.

## Testing Guidelines
- Tests live in `crates/e2e/tests/` and follow Rust’s `*_test` or descriptive module naming.
- Run `cargo test --workspace` before opening a PR.
- Add coverage for gameplay logic changes and any new public APIs.

## Commit & Pull Request Guidelines
- Conventional Commits are required (enforced by lefthook). Format: `type(scope): message`.
- Include a brief PR description, test steps, and screenshots for visible changes.
- If you update release behavior, confirm the version in `crates/game/Cargo.toml`.

## Configuration & Deployment Notes
- Web builds use Trunk (`Trunk.toml`) and output to `dist/`.
- The Cloudflare Worker config is `wrangler.jsonc` and deploys to `dino.lqxclqxc.com`.
- Avoid committing generated output like `dist/` unless a release process requires it.
