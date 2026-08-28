[![Build Status](https://img.shields.io/github/actions/workflow/status/lovebaihezi/dinosaur-game/build.yml?branch=main&label=build)](https://github.com/lovebaihezi/dinosaur-game/actions/workflows/build.yml)

# Dinosaur Game

A Rust implementation of the classic Chrome Dinosaur Game. This project is built with the Bevy game engine and runs on native platforms (Windows, macOS, Linux) and the web (via WebAssembly).

## Web Build Tooling

Run `bun just.ts web` to install the WASM prerequisites and build the web bundle. The stable Trunk release and the SHA-256 checksums of its official platform archives are pinned in `just.ts`. Update `TRUNK_VERSION` and every corresponding checksum deliberately when upgrading Trunk. This avoids Cargo re-resolving Trunk's internal dependencies and makes the install independent of host compiler changes. The Rust compiler, required components, and WASM target are pinned in `rust-toolchain`.

## How to Play

You can play the web version of the game [here](https://dino.lqxclqxc.com).
Every commit pushed to `main` is deployed to this URL with Wrangler.

## Downloads

You can download the latest native versions of the game from the [releases page](https://github.com/lovebaihezi/dinosaur-game/releases).

## Release Process

This project uses an automated release system:

- **Stable Releases**: Created automatically when the version in `crates/game/Cargo.toml` is updated and pushed to the main branch. The workflow creates a version tag (e.g., `0.1.0`) which triggers builds for all platforms (Linux, Windows, macOS x86_64, macOS ARM64).

- **Nightly Releases**: Created automatically on weekdays (Monday-Friday) via scheduled workflow. Tagged with the format `nightly-YYYY-MM-DD`.

To create a new stable release:
1. Update the version number in `crates/game/Cargo.toml`
2. Commit and push to the main branch
3. The automated workflow will create a tag and trigger the build process
4. Binaries will be available on the releases page once builds complete

## Contributing

### Commit Message Convention

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification. Commit messages are enforced via a Git hook (using [lefthook](https://github.com/evilmartians/lefthook)).

**Format:** `<type>(<optional scope>): <description>`

**Allowed types:**
- `feat` - A new feature
- `fix` - A bug fix
- `docs` - Documentation only changes
- `style` - Changes that do not affect the meaning of the code
- `refactor` - A code change that neither fixes a bug nor adds a feature
- `perf` - A code change that improves performance
- `test` - Adding missing tests or correcting existing tests
- `build` - Changes that affect the build system or dependencies
- `ci` - Changes to CI configuration files and scripts
- `chore` - Other changes that don't modify src or test files
- `revert` - Reverts a previous commit

**Examples:**
```
feat: add user login feature
fix(auth): resolve token expiration issue
docs: update README with installation instructions
```

### Setup Git Hooks

After cloning the repository, install lefthook to enable the commit message validation:

```bash
# Install lefthook (if not already installed)
# macOS
brew install lefthook
# or using npm
npm install -g lefthook

# Install the hooks
lefthook install
```
