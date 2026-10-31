import { resolve } from "node:path"
import { afterEdit, type FeedbackDeps, mainStop, subagentStop } from "../../../application/feedback/agent-events.js"
import { type Io, reportError, UsageError } from "../cli/cli-io.js"
import { projectFiles } from "../cli/project-paths.js"
import { parseHookInput } from "./hook-input.js"

/** Exit codes as Claude Code reads them: 2 blocks and sends stderr to Claude, any other non-zero code is only shown to the user. */
export const HOOK_EXIT = { pass: 0, error: 1, block: 2 } as const

const HOOK_EVENTS = ["post-edit", "stop", "subagent-stop"] as const

/** What the post-edit hook sends to Claude when the checks fail. */
function editNote(report: string): string {
  return `Interlint: the checks fail after this edit.\n\n${report}`
}

/**
 * A Claude Code hook. Any error exits 1, never 2: Claude Code would read 2 as a block
 * and keep the agent going on a problem it cannot fix.
 */
export async function hook(args: string[], io: Io, deps: FeedbackDeps): Promise<number> {
  try {
    const [agent, event, ...extra] = args
    if (agent !== "claude-code") throw new UsageError(`hook needs the agent claude-code (got "${agent ?? ""}")`)
    if (!(HOOK_EVENTS as readonly (string | undefined)[]).includes(event) || extra.length > 0) {
      const names = `${HOOK_EVENTS.slice(0, -1).join(", ")} and ${HOOK_EVENTS.at(-1)}`
      throw new UsageError(`claude-code hooks are ${names} (got "${args.slice(1).join(" ")}")`)
    }
    const input = parseHookInput(io.stdin ? await io.stdin() : "")
    const projectDir = resolve(io.cwd, process.env.CLAUDE_PROJECT_DIR || input.cwd || ".")

    if (event === "post-edit") {
      if (input.filePath === undefined) return HOOK_EXIT.pass
      const changed = projectFiles(input.cwd ?? io.cwd, projectDir, [input.filePath])
      const output = await afterEdit(projectDir, input, changed, deps)
      if (output === "") return HOOK_EXIT.pass
      io.stderr(editNote(output))
      return HOOK_EXIT.block
    }

    if (event === "subagent-stop") {
      const decision = await subagentStop(projectDir, input, deps)
      if (decision.action !== "block") return HOOK_EXIT.pass
      io.stderr(decision.text)
      return HOOK_EXIT.block
    }

    // Only the projects the agent changed since their checks last passed, as the OpenCode plugin does.
    const decision = await mainStop(projectDir, input, deps)
    if (decision.action === "block") {
      io.stderr(decision.text)
      return HOOK_EXIT.block
    }
    // Past the limit the task may end, and the user still sees the failures.
    if (decision.action === "report") io.stdout(`${JSON.stringify({ systemMessage: decision.text })}\n`)
    return HOOK_EXIT.pass
  } catch (error) {
    reportError(error, io)
    return HOOK_EXIT.error
  }
}
