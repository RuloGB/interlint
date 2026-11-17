import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentFiles } from "../../../application/setup/ports.js"
import { type InterlintHook, withInterlintHooks } from "./claude-code-settings.js"

/** The project's Codex hooks. Codex loads them once the user trusts the project's `.codex/` layer. */
export const CODEX_HOOKS_FILE = ".codex/hooks.json"

/**
 * `apply_patch` is Codex's edit tool; the matcher also takes `Edit` and `Write`, which Codex sends as `apply_patch`.
 * `Stop` fires for the main agent only; a subagent fires `SubagentStop`, so it gets the failures of its own changes.
 * `SessionStart` keeps the protected files as they are. No pre-edit hook: Codex hooks cannot ask the user.
 * `UserPromptSubmit` reads `interlint: pause` and `interlint: resume` in the user's prompt.
 */
const HOOKS: InterlintHook[] = [
  { event: "SessionStart", command: "interlint hook codex session-start", timeout: 30 },
  { event: "UserPromptSubmit", command: "interlint hook codex user-prompt", timeout: 120 },
  { event: "PostToolUse", matcher: "apply_patch|Edit|Write", command: "interlint hook codex post-edit", timeout: 120 },
  { event: "Stop", command: "interlint hook codex stop", timeout: 600 },
  { event: "SubagentStop", command: "interlint hook codex subagent-stop", timeout: 600 },
]

/**
 * The project's Codex hooks with Interlint's added. The other hooks, and `.codex/config.toml`, stay as they are. A file
 * that needs no change keeps its exact text: Codex asks the user to trust a hook again whenever it changes.
 */
export const codexHookFiles: AgentFiles = (projectDir) => {
  const path = join(projectDir, CODEX_HOOKS_FILE)
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  return [{ path: CODEX_HOOKS_FILE, content: withInterlintHooks(current, CODEX_HOOKS_FILE, HOOKS), replace: true }]
}
