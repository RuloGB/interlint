# Claude Code

Interlint works with Claude Code through three hooks in the project's settings.

## Set it up

```bash
interlint init --agent claude-code
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this adds three hooks to the project's `.claude/settings.json`, the one you commit:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "interlint hook claude-code post-edit", "timeout": 120 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code stop", "timeout": 600 }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code subagent-stop", "timeout": 600 }]
      }
    ]
  }
}
```

- Other settings and hooks in the file stay as they are.
- Running `init` again leaves the file unchanged, and replaces an older Interlint hook instead of adding a second one.
- If the file is not valid JSON, `init` writes nothing.

`interlint` must be on the `PATH` that Claude Code runs hooks with.

## What the hooks do

- **After `Edit` or `Write`,** `post-edit` runs the `edit` checks for that file. Claude gets the failures right after the edit.
- **When Claude finishes,** `stop` runs the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If one fails, Claude cannot stop and gets the failures to fix them. After 3 blocks in a row it lets the task end and shows you the failures once; it does not block again until the next turn. Only the main agent runs it: a subagent ends with `SubagentStop`.
- **When a subagent finishes,** `subagent-stop` runs the checks of the projects holding the files that subagent changed with `Edit` or `Write`, so the failures go to the agent that wrote the code. A subagent that changed no file, such as a read-only reviewer, runs nothing. If a check fails, the subagent cannot stop and gets the failures to fix them, before the main agent gets its answer. After 3 blocks in a row it lets the subagent stop, and the main agent's `stop` gets the failures it could not fix.

A subagent running in the background may still be fixing its failures when the main agent finishes; then the main agent's `stop` sees them too. Two agents that change the same project share its failures: Interlint checks projects, not lines.

The count of blocks, per session and per subagent, and the files each subagent changed are kept in your user's state directory; the files of a subagent that never stopped are forgotten after a week: `%LOCALAPPDATA%\interlint` on Windows, `$XDG_STATE_HOME/interlint` or `~/.local/state/interlint` elsewhere. A relative `LOCALAPPDATA` or `XDG_STATE_HOME` is ignored.

## `interlint hook claude-code`

`interlint hook claude-code post-edit|stop|subagent-stop` reads the hook's JSON on stdin and runs the checks in the project (`CLAUDE_PROJECT_DIR`). It exits with Claude Code's codes instead of the ones of `interlint check`:

| Exit code | Meaning |
|---|---|
| 0 | Nothing for the agent: the checks passed, or no check reads the edited file |
| 2 | A check failed: the failures go to Claude on stderr |
| 1 | Interlint could not run, for example without `interlint.yaml`. Claude Code shows it to you and does not block |
