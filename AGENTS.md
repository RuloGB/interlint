# AGENTS.md

Guide for AI coding agents working on this repository. For what Interlint does, read [README.md](README.md); for how users run it, [docs/usage.md](docs/usage.md).

## What this project is

Interlint is a Node CLI (`interlint`, TypeScript, ESM) that runs a project's existing checks (ArchUnit, Checkstyle, PMD on Maven) inside an AI agent's session and feeds violations back to the agent. It integrates with:

- **Claude Code** through hooks written to `.claude/settings.json` ([docs/claude-code.md](docs/claude-code.md)).
- **OpenCode** through the plugin in `integrations/opencode/interlint/` ([docs/opencode.md](docs/opencode.md)).

Interlint has no rules of its own. Do not add analysis logic: it runs the user's commands and reads their reports.

## Commands

Requires Node 22 or later.

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies |
| `npm run typecheck` | Type-checks `src/`, `test/` and `integrations/` |
| `npm run build` | Removes `dist/` and compiles `src/` into it |
| `npm test` | Runs the Vitest suite. `test/package.test.ts` reads `dist/`, so build first |
| `npm run test:pack` | Packs Interlint and runs `npx interlint init` from the tarball in a clean Maven project |

Before you report a change as done, run `npm run typecheck`, `npm run build` and `npm test`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs those plus `test:pack` on Linux, Windows and macOS.

## Architecture

`src/` follows a hexagonal layout. `test/architecture.test.ts` enforces it, so a wrong import fails the suite.

| Path | Layer | May import |
|---|---|---|
| `src/domain/` | Pure model: checks, violations, Maven commands, project facts | Nothing outside `domain` |
| `src/application/<use-case>/` | Use cases (`checking`, `feedback`, `setup`) and their `ports.ts` | `domain` only |
| `src/adapters/driving/` | Entry points: the CLI and the Claude Code hook | `domain`, `application` |
| `src/adapters/driven/<adapter>/` | Implementations of ports: `fs`, `maven`, `process`, `state`, `yaml-config`, `agents` | `domain`, `application`, and its own adapter only |
| `src/main.ts` | Composition root: wires use cases to adapters | Anything |

Rules that follow from it:

- `domain` and `application` import no npm package and no Node built-in. I/O goes behind a port in `ports.ts`.
- A driven adapter never imports another driven adapter.
- New adapters are wired only in `src/main.ts`.
- `integrations/opencode/interlint/index.ts` is copied into the user's project by `interlint init`. It imports only Node built-ins and talks to Interlint by running the `interlint` CLI.

## Code style

- Strict TypeScript with `noUncheckedIndexedAccess`. ESM with `NodeNext` resolution: relative imports end in `.js`.
- No semicolons, double quotes, two-space indent. Match the surrounding code; there is no formatter or linter.
- Ports are function types or small interfaces. Adapters are plain functions or objects that implement them, injected through `*Deps` objects.
- Comments are short JSDoc that say what a thing is or why, not how. Do not add comments that repeat the code.
- Errors that users see are typed (`ConfigError`, `AgentSetupError`) and turned into messages at the driving adapter.
- Everything must work on Windows, Linux and macOS: build paths with `node:path`, and do not assume a POSIX shell.

## Tests

- Tests live in `test/*.test.ts` and use Vitest. Import source from `../src/...js`.
- Test use cases through their public functions with fake adapters (see `fakeDeps` in `test/run-checks.test.ts`), not through mocks of internals.
- Keep scratch files in a temporary directory (`mkdtempSync(join(tmpdir(), ...))`), never in the repository.
- A behavior change comes with a test that fails without it. When you change a command, option or message, update its tests and the docs that show it.

## Documentation

- User docs are in `docs/` and are published with the package. Keep them in sync with the CLI, `interlint.yaml` and the agent integrations.
- Write in English, in short plain sentences, as the existing docs do.

## Git

- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional scope such as `fix(opencode):`. Releases are `chore(release): x.y.z`.
- No AI attribution in commits or pull requests: no `Co-Authored-By` trailers for AI agents and no "Generated with" lines.
- Branch from `main` with a matching prefix (`feat/...`, `fix/...`, `docs/...`) and open a pull request. Do not push to `main`.
- Do not commit `dist/`, `node_modules/` or local agent state (`.atl/`, `.compendio/`, `odd/`).
