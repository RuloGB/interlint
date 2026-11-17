import type { AgentFiles } from "../../../application/setup/ports.js"

/** Interlint's own hook file. Copilot CLI, the GitHub Copilot app and the Copilot agent in VS Code all read it. */
export const COPILOT_HOOKS_FILE = ".github/hooks/interlint.json"

/**
 * `postToolUse` runs only for the tools that change files. `agentStop` fires for the main agent only; a subagent fires
 * `subagentStop`, so it gets the failures of its own changes. `timeoutSec` is in seconds: the edit one matches the
 * OpenCode plugin's edit timeout, the stop ones give Maven time; past it, Copilot does not block. `sessionStart` keeps
 * the protected files as they are, and `preToolUse` asks the user before an edit changes one. `userPromptSubmitted`
 * reads `interlint: pause` and `interlint: resume` in the user's prompt.
 */
const HOOKS = {
  version: 1,
  hooks: {
    sessionStart: [{ type: "command", command: "interlint hook copilot session-start", timeoutSec: 30 }],
    userPromptSubmitted: [{ type: "command", command: "interlint hook copilot user-prompt", timeoutSec: 120 }],
    preToolUse: [
      {
        type: "command",
        matcher: "edit|create|str_replace_editor|apply_patch",
        command: "interlint hook copilot pre-edit",
        timeoutSec: 30,
      },
    ],
    postToolUse: [
      {
        type: "command",
        matcher: "edit|create|str_replace_editor|apply_patch",
        command: "interlint hook copilot post-edit",
        timeoutSec: 120,
      },
    ],
    agentStop: [{ type: "command", command: "interlint hook copilot stop", timeoutSec: 600 }],
    subagentStop: [{ type: "command", command: "interlint hook copilot subagent-stop", timeoutSec: 600 }],
  },
}

/** Interlint's GitHub Copilot hooks, in a file of their own: the other files in `.github/hooks` stay as they are. */
export const copilotHookFiles: AgentFiles = () => [
  { path: COPILOT_HOOKS_FILE, content: `${JSON.stringify(HOOKS, null, 2)}\n`, replace: true },
]
