# Claude Code

Interlint works with Claude Code through two hooks in the project's settings.

## Set it up

```bash
interlint init --agent claude-code
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this adds two hooks to the project's `.claude/settings.json`, the one you commit:

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
- **When Claude finishes,** `stop` runs every check. If one fails, Claude cannot stop and gets the failures to fix them. After 3 blocks in a row it lets the task end and shows you the failures once; it does not block again until the next turn.

The count of blocks is kept per session in your user's state directory: `%LOCALAPPDATA%\interlint` on Windows, `$XDG_STATE_HOME/interlint` or `~/.local/state/interlint` elsewhere. A relative `LOCALAPPDATA` or `XDG_STATE_HOME` is ignored.

## `interlint hook claude-code`

`interlint hook claude-code post-edit|stop` reads the hook's JSON on stdin and runs the checks in the project (`CLAUDE_PROJECT_DIR`). It exits with Claude Code's codes instead of the ones of `interlint check`:

| Exit code | Meaning |
|---|---|
| 0 | Nothing for the agent: the checks passed, or no check reads the edited file |
| 2 | A check failed: the failures go to Claude on stderr |
| 1 | Interlint could not run, for example without `interlint.yaml`. Claude Code shows it to you and does not block |
