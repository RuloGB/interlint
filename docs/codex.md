# Codex

Interlint works with Codex CLI, OpenAI's coding agent, through three hooks in the project's `.codex/hooks.json`.

This integration follows the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks.md). It was built against Codex CLI 0.149 on Windows, but has not yet been tested end to end in a real Codex session. Codex hooks are stable since Codex CLI 0.124.

## Set it up

```bash
interlint init --agent codex
```

Besides `interlint.yaml` (see [Using Interlint](usage.md)), this writes `.codex/hooks.json`, which you commit:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "apply_patch|Edit|Write",
        "hooks": [{ "type": "command", "command": "interlint hook codex post-edit", "timeout": 120 }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "interlint hook codex stop", "timeout": 600 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "interlint hook codex subagent-stop", "timeout": 600 }] }]
  }
}
```

- Other hooks in `.codex/hooks.json` stay as they are. `.codex/config.toml` is never touched.
- Running `init` again leaves the file byte for byte as it was, and replaces an older version of Interlint's hooks.
- If you edited `interlint.yaml`, `init --agent codex` keeps it and still writes the hooks. Only `--force` replaces it.
- `timeout` is in seconds and gives Maven time. When a hook takes longer, Codex goes on without it and does not block.

`interlint` must be on the `PATH` that Codex runs hooks with.

### Trust the hooks

Codex runs a project's hooks only after you trust them. **Until you do, Codex skips them without telling you**: the agent edits and finishes as if Interlint were not there, and `interlint metrics --agent codex` shows nothing.

1. Open Codex in the project and trust the project when Codex asks. Codex loads `.codex/` only from a trusted project.
2. Approve Interlint's three hooks:
   - **Codex CLI:** run `/hooks` and trust the hooks from this project.
   - **Codex app:** open **Review hooks** (or **Settings > Hooks**). It lists the three hooks as **New**, with **This project** as their origin: `PostToolUse` with `interlint hook codex post-edit`, **Subagent stop** with `interlint hook codex subagent-stop` and **Stop** with `interlint hook codex stop`. Choose **Allow all**, or select the three and choose **Allow selected**. **Not now** leaves them off.

To check that they run, ask the agent for an edit that breaks a check. After the edit, Codex shows `✗ Interlint · checks failed after this edit`.

Codex trusts each hook by its content. When a hook changes, for example after a new Interlint version updates `.codex/hooks.json`, Codex skips it until you approve it again. `init` reminds you of this when it writes the file, and never trusts the hooks for you.

## What the hooks do

- **After a patch,** `post-edit` reads the files the `apply_patch` call adds, updates or moves to, and runs the `edit` checks for them in one run. A patch that only deletes files, or that touches no file a check reads, runs nothing. If the input holds no patch Interlint can read, it runs nothing and says why on stderr. Codex adds the failures to the agent's context next to the patch's result, and shows you a line saying which checks failed. When the checks pass, you see a line saying so. A check with [`every` or `lines`](usage.md#every-n-files-or-lines) counts the files and the added lines of the whole patch.
- **When the agent finishes,** `stop` runs the checks of the projects that changed since their checks last passed (see [At task end](usage.md#at-task-end)). If one fails, the agent cannot stop: Codex gives it the failures as a new prompt. After 3 blocks in a row it lets the task end and shows you the failures; it does not block again until the next turn.
- **When a subagent finishes,** `subagent-stop` runs the checks of the projects holding the files that subagent changed. A subagent that changed no file runs nothing. If a check fails, the subagent cannot stop and gets the failures. After 3 blocks in a row it lets the subagent stop, and the main agent's `stop` gets the failures it could not fix.

Codex does not give a hook the project's directory, so the hooks use the session's working directory, from the input's `cwd`. Start Codex at the folder that holds `interlint.yaml`.

The count of blocks and the files each subagent changed are kept in your user's state directory, as for [Claude Code](claude-code.md).

Each check the hooks run is kept in your [metrics](usage.md#metrics) with `agent: "codex"`, the session and the model, which Codex gives in each hook's input. A subagent's checks also have `subagent: true` and its type.

## Not tested yet

- A real Codex session. The hooks follow the documented input and output, and the tests use that format.
- Whether a subagent's `PostToolUse` input names the subagent. If it does not, a subagent's own stop finds no files to check, and the main agent's `stop` still checks every changed project.
- The Codex IDE extension and Codex cloud.

## `interlint hook codex`

`interlint hook codex post-edit|stop|subagent-stop` reads the hook's JSON on stdin and runs the checks in the project (the input's `cwd`). It always exits 0 when it ran, as Codex reads a hook's JSON answer only then:

| Exit code | Meaning |
|---|---|
| 0 | The hook ran. When a check failed, stdout holds the answer: `hookSpecificOutput.additionalContext` with the failures for `post-edit`, or `"decision": "block"` with the failures as `reason` for `stop` and `subagent-stop`. Otherwise stdout holds a `systemMessage` for you, or nothing |
| 1 | Interlint could not run, for example without `interlint.yaml`. The agent goes on |
