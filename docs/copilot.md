# GitHub Copilot

Interlint works with GitHub Copilot through three hooks in the repository. Copilot CLI, the GitHub Copilot app and the Copilot agent in VS Code share one hook system, so one setup covers them.

Copilot's hooks are in preview and may change. This page was tested with Copilot CLI 1.0.110, run by the GitHub Copilot app on Windows, on a Copilot Free plan, with edits by the main agent and by a subagent, through `edit`, `create` and `apply_patch`.

## Set it up

```bash
interlint init --agent copilot
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this writes `.github/hooks/interlint.json`, which you commit:

```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "matcher": "edit|create|str_replace_editor|apply_patch",
        "command": "interlint hook copilot post-edit",
        "timeoutSec": 120
      }
    ],
    "agentStop": [{ "type": "command", "command": "interlint hook copilot stop", "timeoutSec": 600 }],
    "subagentStop": [{ "type": "command", "command": "interlint hook copilot subagent-stop", "timeoutSec": 600 }]
  }
}
```

- The file is Interlint's own. Other files in `.github/hooks/` stay as they are.
- Running `init` again leaves the file unchanged, and replaces an older version of it.
- If you edited `interlint.yaml`, `init --agent copilot` keeps it and still writes the hooks. Only `--force` replaces it.
- `timeoutSec` gives Maven time. When a hook takes longer, Copilot goes on without it and does not block.

`interlint` must be on the `PATH` that Copilot runs hooks with.

### Trust the folder

Copilot runs the hooks of a repository only in a folder you trust. In a folder you have not trusted, it skips them without telling you; its log in `~/.copilot/logs` says so. Trust the folder when Copilot asks, or add it to `trustedFolders` in `~/.copilot/config.json`.

Copilot Business and Enterprise can turn hooks off for an organization. Then Interlint does not run.

## What the hooks do

- **After a tool changes a file** (`edit`, `create`, `str_replace_editor` or `apply_patch`; a `str_replace_editor` that only views a file runs nothing), `post-edit` runs the `edit` checks for that file. Copilot adds the failures to the tool's result, so the agent reads them right after the edit. A check with [`every` or `lines`](usage.md#every-n-files-or-lines) runs only on the edit that brings it to that many edited files or written lines. The hook counts the lines each `edit` adds or changes, every line of a `create`, and the added lines of a patch.
- **When the agent finishes,** `stop` runs the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If one fails, the agent cannot stop: Copilot gives it the failures as its next prompt. After 3 blocks in a row it lets the task end; it does not block again until the next turn. Copilot itself stops after 8 blocks in a row.
- **When a subagent finishes,** `subagent-stop` runs the checks of the projects holding the files that subagent changed. A subagent that changed no file runs nothing. If a check fails, the subagent cannot stop and gets the failures. After 3 blocks in a row it lets the subagent stop, and the main agent's `stop` gets the failures it could not fix.

Copilot has no way for a hook to show you a message. When the checks pass, the hooks answer nothing. When the task ends after 3 blocks, the failures, the checks that passed and any notice go to stderr, which Copilot keeps in its log. A notice for the agent, such as a [FreezingArchRule store frozen from broken classes](usage.md#freezingarchrule-store-frozen-from-broken-classes), comes after the failures when a stop blocks.

The count of blocks and the files each subagent changed are kept in your user's state directory, as for [Claude Code](claude-code.md).

Each check the hooks run is kept in your [metrics](usage.md#metrics) with `agent: "copilot"`, the session, and the model of the agent's last answer, read from the end of the session's `events.jsonl`. A subagent's checks have `subagent: true` and its type, but no model: the file does not say which answers are the subagent's. When the file cannot be read, the model is left out and the checks run the same.

## With Claude Code in the same project

Copilot also runs the hooks in `.claude/settings.json`. There they could not block, and `post-edit` could not see the edited file. So when Copilot runs `interlint hook claude-code`, it runs no check and leaves a line in Copilot's log that says why. The checks run once, through `.github/hooks/interlint.json`. A project can keep both setups: Claude Code runs its own hooks, and Copilot runs its own.

## Not tested yet

- The Copilot agent in VS Code. It reads `.github/hooks/` too, and should work the same.
- Copilot in other IDEs, such as IntelliJ.
- The Copilot cloud agent. It reads only `.github/hooks/`, but needs `interlint`, Node and Maven in its container.

## `interlint hook copilot`

`interlint hook copilot post-edit|stop|subagent-stop` reads the hook's JSON on stdin and runs the checks in the project (`COPILOT_PROJECT_DIR`, or the input's `cwd`). It always exits 0 when it ran, as Copilot reads a hook's answer only then:

| Exit code | Meaning |
|---|---|
| 0 | The hook ran. When a check failed, stdout holds the answer: `additionalContext` with the failures for `post-edit`, or `"decision": "block"` with the failures as `reason` for `stop` and `subagent-stop`. Otherwise stdout is empty |
| 1 | Interlint could not run, for example without `interlint.yaml`. Copilot logs it and the agent goes on |
