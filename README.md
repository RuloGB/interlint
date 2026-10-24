# Interlint

A deterministic harness for AI coding agents. Interlint runs the checks your project **already has** (ArchUnit, Checkstyle, PMD…) as early as possible inside the agent's session, and makes the agent fix any violation in that same session before it moves on.

> **Status:** in development. Task-end checks with ArchUnit and the OpenCode V2 adapter work from a local build. Nothing is published yet.

## Why

Code rules usually live in two disconnected places:

- As text in `AGENTS.md`, which the agent may forget and nobody enforces.
- As checks (ArchUnit tests, Checkstyle, PMD), which the agent only hears about when someone builds or CI fails.

By then the fix comes late, outside the session, and by hand.

## How it works

- **After each edit:** fast checks run through the agent's post-edit hook, and failures go straight back to the agent.
- **At task end:** slower checks that need a full build run through the agent's stop hook. If they fail, the agent cannot finish until everything is green.

Interlint defines no rules and has no analysis engine of its own: your existing tools remain the single source of truth.

## Try it from a local build

Requires Node 22 or later.

1. Build and link the CLI:

   ```bash
   npm install && npm run build && npm link
   ```

2. Add `interlint.yaml` to the root of your Maven project:

   ```yaml
   checks:
     - name: architecture
       run: ./mvnw -q test -Dtest=ArchitectureRulesTest
       report: archunit
       when: task-end
   ```

3. Run the checks:

   ```bash
   interlint check --when task-end
   ```

   It prints nothing and exits with 0 when every check passes. Otherwise it prints each violated rule, with the text of its `because()` and every violation with its source file and line.

| Exit code | Meaning |
|---|---|
| 0 | Every check passed |
| 1 | A check failed: violations, or a command that failed without leaving any |
| 2 | Configuration or usage error, or an unexpected Interlint error |

On Windows, a leading `./` in `run` becomes `.\`, so the same `interlint.yaml` works on every operating system.

### OpenCode V2

Copy `adapters/opencode/interlint/` to `.opencode/plugins/interlint/` in your project. When the agent tries to finish, the plugin runs `interlint check --when task-end`. If a check fails, it sends the failures back to the session so the agent fixes them. After 3 failed attempts in a row it reports the failures and lets the task end.

To run a CLI that is not on the `PATH`, register the plugin in `opencode.json` with the `command` option:

```jsonc
{
  "plugins": [{ "package": "./.opencode/plugins/interlint", "options": { "command": "node /path/to/interlint/dist/cli.js" } }]
}
```

## Planned

- `interlint init`: detects the project's checks and generates `interlint.yaml`.
- `interlint check --when edit`: fast checks after each edit.
- Adapter for Claude Code.
- `report: maven` for Checkstyle and PMD.
- Distribution through npm.
