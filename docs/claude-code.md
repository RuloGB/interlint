# Claude Code

Interlint works with Claude Code through six hooks in the project's settings.

## Set it up

```bash
interlint init --agent claude-code
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this adds six hooks to the project's `.claude/settings.json`, the one you commit:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code session-start", "timeout": 30 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code user-prompt", "timeout": 120 }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "interlint hook claude-code pre-edit", "timeout": 30 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "interlint hook claude-code post-edit", "timeout": 120, "statusMessage": "Interlint: running checks" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code stop", "timeout": 600, "statusMessage": "Interlint: running checks" }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "interlint hook claude-code subagent-stop", "timeout": 600, "statusMessage": "Interlint: running checks" }]
      }
    ]
  }
}
```

- Other settings and hooks in the file stay as they are.
- Running `init` again leaves the file unchanged, and replaces an older Interlint hook instead of adding a second one.
- `statusMessage` is what Claude Code shows while the hook runs, so you know the checks are still running after Claude writes its last message.
- If you edited `interlint.yaml`, `init --agent claude-code` keeps it and still writes the hooks. Only `--force` replaces it.
- If the file is not valid JSON, `init` writes nothing.

`interlint` must be on the `PATH` that Claude Code runs hooks with.

GitHub Copilot also runs the hooks in `.claude/settings.json`. When it does, `interlint hook claude-code` does nothing: set up Copilot with `init --agent copilot` (see [GitHub Copilot](copilot.md)).

## What the hooks do

- **When the session starts,** `session-start` keeps a hash of each [protected file](usage.md#protected-files), so the task end can tell which ones changed. A resumed or compacted session keeps the first hash.
- **When you send a message,** `user-prompt` reads `interlint: pause` and `interlint: resume` in it (see [Pausing Interlint](usage.md#pausing-interlint)). Without them it does nothing.
- **Before `Edit` or `Write`** changes a protected file, `pre-edit` makes Claude Code ask you whether to allow it, with a message that names the file. Other edits go through as usual. An edit you allow becomes the new reference for that file.
- **After `Edit` or `Write`,** `post-edit` runs the `edit` checks for that file. Claude gets the failures right after the edit, and you see a line that names the checks that failed, such as `✗ Interlint · checks failed after this edit: architecture`. A check with [`every` or `lines`](usage.md#every-n-files-or-lines) runs only on the edit that brings it to that many edited files or written lines, on all of them; Claude and its subagents add to the same count. The hook counts the lines each `Edit` adds or changes, and every line of a `Write`.
- **When Claude finishes,** `stop` runs the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If one fails, Claude cannot stop and gets the failures to fix them. The message tells it to fix them even if you asked it to change nothing else: asking you whether to fix them does not end the task. A protected file changed without your approval, by any means, blocks it too. After 3 blocks in a row it lets the task end and shows you the failures once; it does not block again until the next turn. Only the main agent runs it: a subagent ends with `SubagentStop`.
- **When a subagent finishes,** `subagent-stop` runs the checks of the projects holding the files that subagent changed with `Edit` or `Write`, so the failures go to the agent that wrote the code. A subagent that changed no file, such as a read-only reviewer, runs nothing. If a check fails, the subagent cannot stop and gets the failures to fix them, before the main agent gets its answer. After 3 blocks in a row it lets the subagent stop, and the main agent's `stop` gets the failures it could not fix.

When the checks that ran pass, `post-edit` and `stop` show you a message that names them, such as `✓ Interlint · checks passed: checkstyle (1.2s)`, so you see that Interlint ran (see [`interlint check`](usage.md#interlint-check)). Claude does not get it. An edit that runs no check, such as one to `README.md`, and a stop with no changed project show nothing. `subagent-stop` shows nothing when its checks pass: the main agent's `stop` shows them.

A notice for you, such as a [FreezingArchRule store frozen from broken classes](usage.md#freezingarchrule-store-frozen-from-broken-classes), comes with `stop` and `subagent-stop`: as a message for you when the stop goes through, or after the failures, for Claude to pass on, when it blocks. `post-edit` leaves it out.

A subagent running in the background may still be fixing its failures when the main agent finishes; then the main agent's `stop` sees them too. Two agents that change the same project share its failures: Interlint checks projects, not lines.

The count of blocks, per session and per subagent, and the files each subagent changed are kept in your user's state directory; the files of a subagent that never stopped are forgotten after a week: `%LOCALAPPDATA%\interlint` on Windows, `$XDG_STATE_HOME/interlint` or `~/.local/state/interlint` elsewhere. A relative `LOCALAPPDATA` or `XDG_STATE_HOME` is ignored.

Each check the hooks run is kept in your [metrics](usage.md#metrics) with `agent: "claude-code"`, the session, and the model of Claude's last answer, read from the end of the session's transcript. In a subagent, it is the subagent's own model, from its transcript, with `subagent: true` and its type, such as `Explore`. When the transcript cannot be read, as when Claude Code changes its format, the model is left out and the checks run the same.

## `interlint hook claude-code`

`interlint hook claude-code session-start|user-prompt|pre-edit|post-edit|stop|subagent-stop` reads the hook's JSON on stdin and runs the checks in the project (`CLAUDE_PROJECT_DIR`). It exits with Claude Code's codes instead of the ones of `interlint check`:

| Exit code | Meaning |
|---|---|
| 0 | The checks passed, or no check reads the edited file. For `session-start`, the hashes were kept. For `pre-edit`, stdout holds `"permissionDecision": "ask"` with the question for you when the edit changes a protected file, and is empty otherwise. A message for you, if any, is on stdout as `systemMessage`. For `post-edit`, it is also the code when a check failed: stdout holds `"decision": "block"` with the failures for Claude as `reason`, and the checks that failed for you as `systemMessage` |
| 2 | A check failed at `stop` or `subagent-stop`: the failures go to Claude on stderr, and it cannot stop yet |
| 1 | Interlint could not run, for example without `interlint.yaml`. Claude Code shows it to you and does not block |
