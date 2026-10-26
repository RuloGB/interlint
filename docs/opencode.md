# OpenCode

Interlint works with OpenCode V2 through a plugin. Tested with OpenCode 2.1.4.

## Set it up

```bash
interlint init --agent opencode
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this copies `integrations/opencode/interlint/` to `.opencode/plugins/interlint/` in your project, replacing an older copy. You can also copy it by hand. It does not touch `opencode.json(c)`: OpenCode loads that directory by itself on start.

`interlint` must be on the `PATH` of the OpenCode server.

## After each edit

After the `edit`, `write` or `patch` tool changes files, the plugin runs `interlint check --when edit` for them. If a check fails, it adds the failures to that tool's result, so the agent sees them right after the edit.

The agent waits for these checks, so they give up after 2 minutes. If they cannot run, the edit result stays as it was and the task-end check reports the problem.

## When a turn ends

The plugin runs `interlint check --when task-end --changed`: the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If a check fails, it sends the failures back to the session and the agent goes on to fix them.

- After 3 failed attempts in a row it reports the failures and lets the task end.
- If the CLI cannot run, or takes longer than 10 minutes, the plugin reports it without making the agent continue.

## Subagents

The failures go to the agent that wrote the code. The agent that delegated the work gets them only when that agent cannot fix them.

- A subagent that changed no file with `edit`, `write` or `patch`, such as a read-only reviewer, runs no task-end checks.
- When a subagent that changed files ends its turn, the plugin runs `interlint check --when task-end --changed --file <path>...` with those files, so the subagent gets the failures of its own projects only. If a check fails, the subagent goes on to fix them, up to 3 attempts.
- The main agent waits for a foreground subagent's answer until its checks pass, and the answer says whether the subagent had to fix them. If the subagent still fails after 3 attempts, or stops before they pass, the answer carries the failures to the main agent, which answers for those files from then on.
- A subagent in the background has already answered when its turn ends, so the plugin sends its parent a message with the failures it could not fix.
- The main agent's turn end still runs the checks of every changed project, for the files it changed itself, by any means. While one of its subagents has changes whose checks have not passed, it waits for that subagent first.

Two agents that change the same project share its failures: Interlint checks projects, not lines.
