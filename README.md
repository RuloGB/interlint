# Interlint

**Your AI coding agent breaks your architecture rules. Interlint makes it fix them before it moves on.**

Interlint runs the checks your project **already has**, such as ArchUnit, inside the agent's session. When the agent breaks a rule, it hears about it right away and fixes it in the same session, not in CI and not by hand.

> **Status:** 1.4.0. It works today with ArchUnit, Checkstyle, PMD, Maven (including multi-module projects and workspaces), OpenCode V2 and Claude Code.

## The problem

Your code rules live in two places that never meet:

- **As text in `AGENTS.md`.** The agent may forget it, and nobody enforces it.
- **As checks** (ArchUnit tests, Checkstyle, PMD). The agent only hears about them when someone builds or CI fails.

By then the agent's session is over, and someone has to fix the code by hand.

## What Interlint does

- **After each edit,** fast checks run and any violation goes straight back to the agent.
- **At task end,** the full checks run, for the projects the agent changed. If a rule is broken, the agent cannot finish until everything is green.

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
- **One command to set up.** `interlint init` finds your ArchUnit tests and your Checkstyle and PMD plugins, and wires your agent.
- **No endless loops.** After 3 failed attempts in a row, Interlint lets the task end and shows you what is still failing.

## Quick start

Requires Node 22 or later and a Maven project with ArchUnit tests, or with Checkstyle or PMD in its `pom.xml`.

1. Install the CLI:

   ```bash
   npm install -g interlint
   ```

2. In the root of your project, or of a workspace that holds several Maven projects, set up your agent:

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
| Checks | ArchUnit, Checkstyle, PMD |
| Build | Maven, with or without the Maven Wrapper or `mvnd` |
| Layout | One project, a multi-module reactor, or a workspace of several Maven projects (other projects in it are ignored) |

## Known limits

- Only Maven projects.
- After an edit, PMD still checks the whole project: it cannot be limited to one file from the command line. Only the failures of the changed file are shown; Checkstyle checks that file alone.

## Documentation

- [Using Interlint](docs/usage.md): `init`, `interlint.yaml`, `check` and exit codes.
- [OpenCode](docs/opencode.md): the plugin, what it does after edits and at turn end, and subagents.
- [Claude Code](docs/claude-code.md): the hooks, their exit codes, the retry limit and subagents.
- [Development](docs/development.md): building, testing and packing Interlint.

## License

[MIT](LICENSE)

## Planned

- `interlint audit`, to find mismatches between `AGENTS.md` and your ArchUnit rules.
