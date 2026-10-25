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

The plugin runs `interlint check --when task-end`. If a check fails, it sends the failures back to the session and the agent goes on to fix them.

- After 3 failed attempts in a row it reports the failures and lets the task end.
- If the CLI cannot run, or takes longer than 10 minutes, the plugin reports it without making the agent continue.
