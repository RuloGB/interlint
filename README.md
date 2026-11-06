<h1 align="center">
  <img src="assets/logo/interlint-banner.svg" alt="Interlint: your AI agent breaks your project rules. Make it fix them before it moves on." width="100%">
</h1>

Interlint runs the checks your project **already has**, such as ArchUnit, inside the agent's session. When the agent breaks a rule, it hears about it right away and fixes it in the same session, not in CI and not by hand.

**Works with [Claude Code](docs/claude-code.md) and [OpenCode](docs/opencode.md)**, on Maven projects that use ArchUnit, Checkstyle or PMD.

> **Status:** 1.11.0. Stable for Maven projects, including multi-module projects and workspaces of several projects.

## The problem

Your code rules live in two places that never meet:

- **As text in `AGENTS.md`.** The agent may forget it, and nobody enforces it.
- **As checks** (ArchUnit tests, Checkstyle, PMD). The agent only hears about them when someone builds or CI fails.

By then the agent's session is over, and someone has to fix the code by hand.

## What Interlint does

- **After each edit,** Checkstyle checks the changed files and any violation goes straight back to the agent. ArchUnit and PMD, which are slower, run after 5 edited files or 100 written lines, whichever comes first. You can change when each check runs in `interlint.yaml`: see [Make it fit your team](#make-it-fit-your-team). This needs [`mvnd`](#install-mvnd-strongly-recommended).
- **At task end,** every check runs for the projects the agent changed. If a rule is broken, the agent cannot finish until everything is green.

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

2. In the root of your project, or of a workspace that holds several Maven projects, set up your agent.

   For **Claude Code**:

   ```bash
   interlint init --agent claude-code
   ```

   For **OpenCode**:

   ```bash
   interlint init --agent opencode
   ```

3. Commit the generated `interlint.yaml` (and `.claude/settings.json` or `.opencode/`), then start your agent as usual.

### Install mvnd (strongly recommended)

> [!IMPORTANT]
> Without [`mvnd`](https://github.com/apache/maven-mvnd) on your `PATH`, Interlint cannot check after each edit. Checkstyle waits for task end too, so the agent only hears about a broken rule when it tries to finish, after it may have built more code on top of it.

`mvnd` keeps Maven running between checks, which makes a check after each edit fast enough, and every check at task end faster. Install it following the instructions in [its repository](https://github.com/apache/maven-mvnd). Interlint finds it on its own: there is nothing to change in `interlint.yaml`.

## Make it fit your team

`interlint.yaml` decides what Interlint does. `init` writes a starting point; the file is yours to edit, and you commit it so the whole team gets the same behavior.

Each check says when it runs:

| Field | What it does |
|---|---|
| `when: edit` | Runs after edits, and again at task end. |
| `when: task-end` | Runs only at task end. |
| `every: <n>` | With `when: edit`, waits until `n` distinct source files were edited. |
| `lines: <n>` | With `when: edit`, waits until `n` lines were written in its sources. |

With both `every` and `lines`, the check runs at whichever comes first. With neither, it runs after each edit. Whatever the setting, every check still runs at task end for the projects the agent changed, so nothing is left unchecked.

For example, to run ArchUnit only once the agent has written 200 lines, whatever the number of files, and leave it to task end otherwise:

```yaml
checks:
  - name: architecture
    run: ./mvnw -q test -Dtest=ArchitectureRulesTest -Dcheckstyle.skip -Dpmd.skip
    report: archunit
    when: edit
    lines: 200
```

Some common choices:

- **Small edits wait for task end:** keep only `lines`, as above. A log line in three files does not run the check; a new feature does.
- **Many files, any size:** keep only `every`.
- **Fast feedback on every edit:** remove `every` and `lines`.
- **Only at the end:** set `when: task-end`.

Only added or changed lines count, not removed ones. When a check fails after an edit, it runs again after each next edit of its sources until it passes, then counts from zero. Maven checks need [`mvnd`](#install-mvnd-strongly-recommended) to run after edits. `init` never overwrites your edited `interlint.yaml` unless you pass `--force`.

See [Every N files or lines](docs/usage.md#every-n-files-or-lines) for the full rules, and [Using Interlint](docs/usage.md) for every field, such as `run`, `report` and `dir`.

## Metrics

Interlint records every check it runs, so you can see which rules your agents break most, and with which models.

```bash
interlint metrics
```

```text
Interlint metrics · shop · 2026-11-05 to 2026-11-06

Checks run: 4 (1 skipped) · violations: 24
By type: checkstyle 21 · pmd 2 · architecture 1
Top rules:
  6  checkstyle  LineLength
  5  checkstyle  MissingJavadocMethod
  4  checkstyle  EmptyCatchBlock

By model (violations per check run):
  claude-opus-5-5   7.33  (3 checks, 1 session)
  unknown           2.00  (1 check, 0 sessions)

Task-end blocks: 1, 1 fixed later in the session
Time spent on checks: 20.0s
```

- **Violations per check run, by model and by agent,** so a model you use more does not look worse just for that.
- **Task-end blocks** show how often the agent tried to finish with a broken rule, and how often it fixed it in the same session.
- `interlint metrics report` writes the full report in Markdown to `interlint-metrics.md`, ready to share or paste into a pull request.
- `--all`, `--since <YYYY-MM-DD>` and `--agent` narrow or widen what it reads.

Metrics stay on your machine, in your user's state directory, never in the project. They keep the rule, its type and the file of each violation, never its message or code. To keep none, set `metrics: false` in `interlint.yaml`.

See [Metrics](docs/usage.md#metrics) for where they are kept, the line format and every option.

## Supported today

| | |
|---|---|
| Agents | Claude Code, OpenCode V2 |
| Checks | ArchUnit, Checkstyle, PMD |
| Build | Maven, with or without the Maven Wrapper; `mvnd` for checks after each edit |
| Layout | One project, a multi-module reactor, or a workspace of several Maven projects (other projects in it are ignored) |

## Known limits

- Only Maven projects.
- PMD cannot be limited to one file from the command line, so it checks the whole project each time it runs. `init` gives it [`every: 5` and `lines: 100`](docs/usage.md#every-n-files-or-lines): it waits for 5 edited files or 100 written lines and shows the failures of all of them.

## Documentation

- [Using Interlint](docs/usage.md): `init`, `interlint.yaml`, `check`, `metrics` and exit codes.
- [OpenCode](docs/opencode.md): the plugin, what it does after edits and at turn end, and subagents.
- [Claude Code](docs/claude-code.md): the hooks, their exit codes, the retry limit and subagents.
- [Development](docs/development.md): building, testing and packing Interlint.

## License

[MIT](LICENSE)
