import { resolve } from "node:path"
import { afterEdit, type FeedbackDeps, mainStop, subagentStop } from "../../../application/feedback/agent-events.js"
import type { AgentContext } from "../../../domain/metric.js"
import { type Io, reportError, UsageError } from "../cli/cli-io.js"
import { projectFiles } from "../cli/project-paths.js"
import { editNote, HOOK_EVENT_NAMES, isHookEvent, withNotice, withPassed } from "../hooks/hook-text.js"
import { type HookInput, parseHookInput } from "./hook-input.js"

/** Exit codes as Claude Code reads them: 2 blocks and sends stderr to Claude, any other non-zero code is only shown to the user. */
export const HOOK_EXIT = { pass: 0, error: 1, block: 2 } as const

/** Why a Claude Code hook that GitHub Copilot runs does nothing. */
const COPILOT_SKIPPED =
  "GitHub Copilot ran a Claude Code hook, which does nothing there: Copilot runs Interlint through .github/hooks/interlint.json (interlint init --agent copilot)"

/** What the post-edit hook shows the user when the checks fail: Claude Code shows the user none of what Claude gets. */
function failedLine(failed: string[]): string {
  return `✗ Interlint · checks failed after this edit: ${failed.join(", ")}`
}

/**
 * Who the hook fires for, for the metrics. The model is the last one in the session's transcript, or in the
 * subagent's own, since a subagent often runs another model (decision 33). None when it cannot be read.
 */
function contextOf(input: HookInput, deps: FeedbackDeps): AgentContext {
  const { sessionId, agentId, agentType, transcriptPath } = input
  const model = transcriptPath === undefined ? undefined : deps.transcriptModel({ path: transcriptPath, agentId })
  return {
    agent: "claude-code",
    ...(sessionId === "" ? {} : { session: sessionId }),
    ...(agentId === undefined ? {} : { subagent: true as const }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
  }
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
    if (agent !== "claude-code") throw new UsageError(`hook needs the agent claude-code or copilot (got "${agent ?? ""}")`)
    if (!isHookEvent(event) || extra.length > 0) {
      throw new UsageError(`claude-code hooks are ${HOOK_EVENT_NAMES} (got "${args.slice(1).join(" ")}")`)
    }
    const input = parseHookInput(io.stdin ? await io.stdin() : "")
    // Copilot also runs the hooks in .claude/settings.json, where it can neither block nor give the edited file: its
    // own hooks, from `init --agent copilot`, run the checks once. A Claude Code started from a Copilot shell inherits
    // COPILOT_CLI, but its input has no timestamp.
    if (process.env.COPILOT_CLI === "1" && input.copilotFormat) {
      // Copilot keeps stderr in its log, so a missing check run can be traced there.
      io.stderr(`interlint: ${COPILOT_SKIPPED}\n`)
      return HOOK_EXIT.pass
    }
    const projectDir = resolve(io.cwd, process.env.CLAUDE_PROJECT_DIR || input.cwd || ".")
    const context = () => contextOf(input, deps)

    if (event === "post-edit") {
      if (input.filePath === undefined) return HOOK_EXIT.pass
      const changed = projectFiles(input.cwd ?? io.cwd, projectDir, [input.filePath])
      // The notice waits for the stop: shown after every edit, it would repeat what the user already read.
      const linesWritten = new Map(changed.map((file) => [file, input.linesWritten]))
      const { report, passed, failed } = await afterEdit(projectDir, input, changed, deps, linesWritten, context())
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
      event === "subagent-stop"
        ? await subagentStop(projectDir, input, deps, context())
        : await mainStop(projectDir, input, deps, context())
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
