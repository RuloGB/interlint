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

/** What the post-edit hook shows the user when the checks fail: Claude Code shows the user none of what Claude gets. */
function failedLine(failed: string[]): string {
  return `✗ Interlint · checks failed after this edit: ${failed.join(", ")}`
}

function withNotice(text: string, notice: string): string {
  if (notice === "") return text
  return text === "" ? notice : `${text.trimEnd()}\n\n${notice}`
}

/** The text with the line of the checks that passed after it, on its own line. */
function withPassed(text: string, passed: string): string {
  if (passed === "") return text
  return text === "" ? passed.trimEnd() : `${text.trimEnd()}\n${passed.trimEnd()}`
}

/** Shows the text to the user only, as Claude Code reads the JSON of a hook that exits 0. Nothing when it is empty. */
function tellUser(io: Io, text: string): void {
  if (text !== "") io.stdout(`${JSON.stringify({ systemMessage: text })}\n`)
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
      // The notice waits for the stop: shown after every edit, it would repeat what the user already read.
      const { report, passed, failed } = await afterEdit(projectDir, input, changed, deps)
      if (report !== "") {
        // The tool already ran: `block` adds the reason next to its result for Claude, and the user reads the message.
        io.stdout(`${JSON.stringify({ decision: "block", reason: editNote(report), systemMessage: failedLine(failed) })}\n`)
        return HOOK_EXIT.pass
      }
      // Only the user reads it, so the user sees Interlint ran and Claude spends nothing on it.
      tellUser(io, withPassed("", passed))
      return HOOK_EXIT.pass
    }

    // Only the projects the agent changed since their checks last passed, as the OpenCode plugin does.
    const { decision, notice, passed } =
      event === "subagent-stop" ? await subagentStop(projectDir, input, deps) : await mainStop(projectDir, input, deps)
    // Claude Code reads stdout only when the hook does not block, so a blocked stop gives Claude the notice to pass on.
    if (decision.action === "block") {
      io.stderr(withNotice(decision.text, notice))
      return HOOK_EXIT.block
    }
    // Past the limit the task may end, and the user still sees the failures. A subagent's checks that passed are not
    // shown: the main agent's stop checks every changed project and shows them.
    const failures = decision.action === "report" && event === "stop" ? decision.text : ""
    tellUser(io, withPassed(withNotice(failures, notice), event === "stop" ? passed : ""))
    return HOOK_EXIT.pass
  } catch (error) {
    reportError(error, io)
    return HOOK_EXIT.error
  }
}
