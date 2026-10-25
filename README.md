# Interlint

**Your AI coding agent breaks your architecture rules. Interlint makes it fix them before it moves on.**

Interlint runs the checks your project **already has**, such as ArchUnit, inside the agent's session. When the agent breaks a rule, it hears about it right away and fixes it in the same session, not in CI and not by hand.

> **Status:** in development. It works today with ArchUnit, Maven, OpenCode V2 and Claude Code, from a local build. It is not on npm yet.

## The problem

Your code rules live in two places that never meet:

- **As text in `AGENTS.md`.** The agent may forget it, and nobody enforces it.
- **As checks** (ArchUnit tests, Checkstyle, PMD). The agent only hears about them when someone builds or CI fails.

By then the agent's session is over, and someone has to fix the code by hand.

## What Interlint does

- **After each edit,** fast checks run and any violation goes straight back to the agent.
- **At task end,** the full checks run. If a rule is broken, the agent cannot finish until everything is green.

This is what the agent sees when it puts infrastructure code in the domain:

```text
✗ architecture · ARCH-01: domain depends on nothing outside domain

  Method <com.acme.domain.Order.toEntity()> calls constructor <com.acme.infra.OrderEntity.<init>()> in (Order.java:27)
    at src/main/java/com/acme/domain/Order.java:27

Fix these problems before continuing.
```

The agent reads the rule, removes the dependency and carries on.

## Why teams use it

- **No new rules to write.** Interlint has no rules and no analysis engine of its own. Your existing checks stay the single source of truth.
- **Deterministic.** Your own build decides, not a prompt the agent may ignore.
- **Feedback when it is cheap.** The agent fixes the violation while it still has the context, before it builds on top of it.
- **One command to set up.** `interlint init` finds your ArchUnit tests and wires your agent.
- **No endless loops.** After 3 failed attempts in a row, Interlint lets the task end and shows you what is still failing.

## Quick start

Requires Node 22 or later and a Maven project with ArchUnit tests.

1. Build and link the CLI from this repository:

   ```bash
   npm install && npm run build && npm link
   ```

2. In the root of your project, set up your agent:

   ```bash
   interlint init --agent opencode
   ```

   or, for Claude Code:

   ```bash
   interlint init --agent claude-code
   ```

3. Commit the generated `interlint.yaml` (and `.opencode/` or `.claude/settings.json`), then start your agent as usual.

For the fastest feedback after each edit, install [`mvnd`](https://github.com/apache/maven-mvnd). Without it, Maven checks run only at task end.

## Supported today

| | |
|---|---|
| Agents | OpenCode V2, Claude Code |
| Checks | ArchUnit |
| Build | Maven, with or without the Maven Wrapper or `mvnd` |

## Known limits

- Not published on npm yet: install it from a local build.
- Only ArchUnit for now. Checkstyle and PMD are planned.
- Only Maven projects.

## Documentation

- [Using Interlint](docs/usage.md): `init`, `interlint.yaml`, `check` and exit codes.
- [OpenCode](docs/opencode.md): the plugin and what it does after edits and at turn end.
- [Claude Code](docs/claude-code.md): the hooks, their exit codes and the retry limit.
- [Development](docs/development.md): building, testing and packing Interlint.

## License

[MIT](LICENSE)

## Planned

- Checkstyle and PMD (`report: maven`).
- Distribution through npm.
- `interlint audit`, to find mismatches between `AGENTS.md` and your ArchUnit rules.
