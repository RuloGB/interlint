# Interlint

A deterministic harness for AI coding agents. Interlint runs the checks your project **already has** (ArchUnit, Checkstyle, PMD…) as early as possible inside the agent's session, and makes the agent fix any violation in that same session before it moves on.

> **Status:** in development. Edit-time and task-end checks with ArchUnit and the OpenCode V2 adapter work from a local build. Nothing is published yet.

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
| 1 | A check failed: violations, a command that failed without leaving any, or a command that wrote no report |
| 2 | Configuration or usage error, or an unexpected Interlint error |

On Windows, a leading `./` in `run` becomes `.\`, so the same `interlint.yaml` works on every operating system.

### After each edit

A check with `when: edit` also runs after the agent changes one of its sources:

```bash
interlint check --when edit --file src/main/java/shop/Order.java
```

- Only `edit` checks run, and only when a changed file inside the project is one of their sources: `*.java` for `report: archunit`. Any other file, such as `README.md`, runs nothing and exits with 0.
- The output and exit codes are the same as at task end. `--file` can be repeated.
- With [`mvnd`](https://github.com/apache/maven-mvnd) on the `PATH`, a check whose `run` starts with `mvn`, `mvnw` or `./mvnw` runs with `mvnd` instead, with the same arguments, at edit time and at task end. Keep `./mvnw` in `interlint.yaml` so it works for teammates without `mvnd`.
- Without `mvnd`, Maven `edit` checks do not run after edits, because a cold Maven build takes several seconds; they still run at task end.
- Check runs on the same project never overlap: a second edit waits until the first one's checks finish.

At task end every check runs, `edit` ones included.

### OpenCode V2

Copy `integrations/opencode/interlint/` to `.opencode/plugins/interlint/` in your project. OpenCode loads it on start; `interlint` must be on the `PATH` of the OpenCode server.

After the `edit`, `write` or `patch` tool changes files, the plugin runs `interlint check --when edit` for them. If a check fails, it adds the failures to that tool's result, so the agent sees them right after the edit. The agent waits for these checks, so they give up after 2 minutes; if they cannot run, the edit result stays as it was and the task-end check reports the problem.

When an agent turn ends, the plugin runs `interlint check --when task-end`. If a check fails, it sends the failures back to the session and the agent goes on to fix them. After 3 failed attempts in a row it reports the failures and lets the task end. If the CLI cannot run, or takes longer than 10 minutes, the plugin reports it without making the agent continue.

Tested with OpenCode 2.1.4.

## Planned

- `interlint init`: detects the project's checks and generates `interlint.yaml`.
- Adapter for Claude Code.
- `report: maven` for Checkstyle and PMD.
- Distribution through npm.
