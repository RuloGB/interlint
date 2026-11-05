# OpenCode

Interlint works with OpenCode V2 through a plugin. Tested with OpenCode 2.1.4.

## Set it up

```bash
interlint init --agent opencode
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this copies `integrations/opencode/interlint/` to `.opencode/plugins/interlint/` in your project, replacing an older copy. If you edited `interlint.yaml`, it keeps it and still updates the plugin; only `--force` replaces it. You can also copy it by hand. It does not touch `opencode.json(c)`: OpenCode loads that directory by itself on start.

`interlint` must be on the `PATH` of the OpenCode server.

One OpenCode server runs the sessions of every project you open in it. The plugin only checks the sessions that run in its own project's directory, or in a directory inside it, symbolic links included, so a project without Interlint open in the same OpenCode is left alone.

## After each edit

After the `edit`, `write` or `patch` tool changes files, the plugin runs `interlint check --when edit` for them. If a check fails, it adds the failures to that tool's result, so the agent sees them right after the edit. OpenCode Desktop shows an edit's diff, not its result, so the plugin also sends you a line in the session that does not make the agent continue: the checks that failed, such as `✗ Interlint · checks failed after this edit: architecture`, or, when they pass, the checks that ran, such as `✓ Interlint · checks passed: checkstyle (1.2s)`. An edit that runs no check, such as one to `README.md`, sends nothing. A check with [`every` or `lines`](usage.md#every-n-files-or-lines) runs only on the edit that brings it to that many edited files or written lines, on all of them; the agent and its subagents add to the same count. The plugin counts the lines each `edit` adds or changes, every line of a `write`, and the `+` lines of each file of a `patch`.

The agent waits for these checks, so they give up after 2 minutes. If they cannot run, the edit result stays as it was and the task-end check reports the problem.

## When a turn ends

The plugin runs `interlint check --when task-end --changed`: the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If a check fails, it sends the failures back to the session and the agent goes on to fix them.

- After 3 failed attempts in a row it reports the failures and lets the task end.
- If the CLI cannot run, or takes longer than 10 minutes, the plugin reports it without making the agent continue.
- If the checks pass, the plugin sends the line that names them as a message in the session, without making the agent continue. When no project changed, no check runs and there is no message.
- If the checks pass with a notice for you, such as a [FreezingArchRule store frozen from broken classes](usage.md#freezingarchrule-store-frozen-from-broken-classes), the plugin reports it without making the agent continue. When a check fails, the notice comes after the failures. The plugin copied by an older `interlint init` does not report it: run `interlint init --agent opencode` again to update it. The same goes for the line of the checks that passed.

OpenCode Desktop shows a message the plugin sends by its first line, such as `Interlint: the task cannot end yet (attempt 1 of 3).` The agent gets the whole message.

## Subagents

The failures go to the agent that wrote the code. The agent that delegated the work gets them only when that agent cannot fix them.

- A subagent that changed no file with `edit`, `write` or `patch`, such as a read-only reviewer, runs no task-end checks.
- When a subagent that changed files ends its turn, the plugin runs `interlint check --when task-end --changed --file <path>...` with those files, so the subagent gets the failures of its own projects only. If a check fails, the subagent goes on to fix them, up to 3 attempts.
- The main agent waits for a foreground subagent's answer until its checks pass, and the answer says whether the subagent had to fix them. If the subagent still fails after 3 attempts, or stops before they pass, the answer carries the failures to the main agent, which answers for those files from then on.
- A subagent in the background has already answered when its turn ends, so the plugin sends its parent a message with the failures it could not fix.
- The main agent's turn end still runs the checks of every changed project, for the files it changed itself, by any means. While one of its subagents has changes whose checks have not passed, it waits for that subagent first.
- Neither wait lasts more than 30 minutes. A subagent whose fix turn has not ended by then counts as stopped, and the main agent's checks run without waiting for it any longer. A subagent whose session is deleted stops at once.

Two agents that change the same project share its failures: Interlint checks projects, not lines.

## Metrics

Each check the plugin runs is kept in your [metrics](usage.md#metrics) with `agent: "opencode"`, the session, and the model and `provider` of the session's last request to its model. Requests OpenCode makes for itself, such as the one that writes the session's title, do not count. Before the first request, or on an OpenCode that does not give plugins its requests, the plugin asks the session for its model. A subagent's checks also get `subagent: true` and its type, such as `explore`. The plugin gives the CLI this context as JSON on stdin, with an option the usage does not show. The plugin copied by an older `interlint init` gives none: run `interlint init --agent opencode` again to update it.
