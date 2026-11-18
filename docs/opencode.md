# OpenCode

Interlint works with OpenCode V2 through a plugin. Tested with OpenCode 2.1.4.

## Set it up

```bash
interlint init --agent opencode
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this copies `integrations/opencode/interlint/` to `.opencode/plugins/interlint/` in your project, replacing an older copy. If you edited `interlint.yaml`, it keeps it and still updates the plugin; only `--force` replaces it. You can also copy it by hand. It does not touch `opencode.json(c)`: OpenCode loads that directory by itself on start.

`interlint` must be on the `PATH` of the OpenCode server.

One OpenCode server runs the sessions of every project you open in it. The plugin only checks the sessions that run in its own project's directory, or in a directory inside it, symbolic links included, so a project without Interlint open in the same OpenCode is left alone.

## Protected files

The plugin protects the files that define your rules (see [Protected files](usage.md#protected-files)):

- When a main session's first turn starts, it runs `interlint check --when session-start`, which keeps a hash of each protected file.
- Before the `edit`, `write` or `patch` tool changes a protected file, it makes OpenCode ask you whether to allow it, with a message that names the file. It asks the CLI with `interlint check --when pre-edit --file <path>...`, which prints the message, or nothing for a file that is not protected. This needs an OpenCode that gives plugins its permission hook. The OpenCode TUI shows the question; OpenCode Desktop 2.2.5 grants it without showing it.
- An edit of a protected file never counts as approved, even one you allowed: the plugin cannot tell your answer from Desktop's. Right after it, the agent is told it changed a protected file, and at turn end the change blocks the main agent as a failed check does, until the file is back as it was or after 3 blocks in a row. A change you want stays for good from the next session.

The CLI options the plugin uses for this, `--when session-start`, `--when pre-edit` and `--root-session`, are not in the usage. Nor are `--when pause` and `--when resume`, which it runs when you [pause or resume Interlint](usage.md#pausing-interlint). Nor is `--when turn-start`, which it runs for each of your messages without a mark in a session that is not paused, so what changed since the agent's last turn ended, such as a `git pull`, is taken as yours (see [Changes made between two turns](usage.md#changes-made-between-two-turns)).

## After each edit

After the `edit`, `write` or `patch` tool changes files, the plugin runs `interlint check --when edit` for them. If a check fails, it adds the failures to that tool's result, so the agent sees them right after the edit. OpenCode Desktop shows an edit's diff, not its result, so the plugin also sends you a line in the session that does not make the agent continue: the checks that failed, such as `✗ Interlint · checks failed after this edit: architecture`, or, when they pass, the checks that ran, such as `✓ Interlint · checks passed: checkstyle (1.2s)`. An edit that runs no check, such as one to `README.md`, sends nothing. A check with [`every` or `lines`](usage.md#every-n-files-or-lines) runs only on the edit that brings it to that many edited files or written lines, on all of them; the agent and its subagents add to the same count. The plugin counts the lines each `edit` adds or changes, every line of a `write`, and the `+` lines of each file of a `patch`.

The agent waits for these checks, so they give up after 2 minutes. If they cannot run, the edit result stays as it was and the task-end check reports the problem.

## When a turn ends

The plugin runs `interlint check --when task-end --changed`: the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If a check fails, it sends the failures back to the session and the agent goes on to fix them. The message tells it to fix them even if you asked it to change nothing else: asking you whether to fix them does not end the task.

- OpenCode shows the turn as ended while the checks run. If they take longer than 2 seconds, the plugin sends `Interlint: running checks` as a message in the session, without making the agent continue, so you know they are still running. Their result follows it, or `Interlint: checks finished` when they end with nothing to report. Checks that end sooner, such as when no project changed, add no message.
- After 3 failed attempts in a row it reports the failures and lets the task end.
- If the CLI cannot run, or takes longer than 10 minutes, the plugin reports it without making the agent continue.
- If the checks pass, the plugin sends the line that names them as a message in the session, without making the agent continue. When no project changed, no check runs and there is no message.
- If the checks pass with a notice for you, such as a [FreezingArchRule store frozen from broken classes](usage.md#freezingarchrule-store-frozen-from-broken-classes), the plugin reports it without making the agent continue. When a check fails, the notice comes after the failures. The plugin copied by an older `interlint init` does not report it: run `interlint init --agent opencode` again to update it. The same goes for the line of the checks that passed.

OpenCode Desktop shows a message the plugin sends by its first line, such as `Interlint: the task cannot end yet (attempt 1 of 3).` The agent gets the whole message.

## Subagents

The failures go to the agent that wrote the code. The agent that delegated the work gets them only when that agent cannot fix them.

- A subagent that changed no file with `edit`, `write` or `patch`, such as a read-only reviewer, runs no task-end checks.
- When a subagent that changed files ends its turn, the plugin runs `interlint check --when task-end --changed --file <path>...` with those files, so the subagent gets the failures of its own projects only. If a check fails, the subagent goes on to fix them, up to 3 attempts.
- You see these checks in the subagent's session, as in the main agent's: `Interlint: running checks` when they take longer than 2 seconds, then the line that names the checks that passed, such as `✓ Interlint · checks passed: checkstyle (1.2s)`. When they still fail after 3 attempts, a line names them, such as `✗ Interlint · checks still fail after 3 attempts: checkstyle. They go to the agent that delegated this work.` When they cannot run, a line says so. If OpenCode takes longer than 5 seconds to show one of these lines, the subagent's answer does not wait for it.
- The main agent waits for a foreground subagent's answer until its checks pass, and the answer says whether the subagent had to fix them. If the subagent still fails after 3 attempts, or stops before they pass, the answer carries the failures to the main agent, which answers for those files from then on.
- A subagent in the background has already answered when its turn ends, so the plugin sends its parent a message with the failures it could not fix.
- The main agent's turn end still runs the checks of every changed project, for the files it changed itself, by any means. While one of its subagents has changes whose checks have not passed, it waits for that subagent first.
- Neither wait lasts more than 30 minutes. A subagent whose fix turn has not ended by then counts as stopped, and the main agent's checks run without waiting for it any longer. A subagent whose session is deleted stops at once.

Two agents that change the same project share its failures: Interlint checks projects, not lines.

## Metrics

Each check the plugin runs is kept in your [metrics](usage.md#metrics) with `agent: "opencode"`, the session, and the model and `provider` of the session's last request to its model. Requests OpenCode makes for itself, such as the one that writes the session's title, do not count. Before the first request, or on an OpenCode that does not give plugins its requests, the plugin asks the session for its model. A subagent's checks also get `subagent: true` and its type, such as `explore`. The plugin gives the CLI this context as JSON on stdin, with an option the usage does not show. The plugin copied by an older `interlint init` gives none: run `interlint init --agent opencode` again to update it.
