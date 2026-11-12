import { resolve } from "node:path"
import { afterEdit, type FeedbackDeps, mainStop, subagentStop } from "../../../application/feedback/agent-events.js"
import type { AgentContext } from "../../../domain/metric.js"
import { type Io, reportError, UsageError } from "../cli/cli-io.js"
import { projectFiles } from "../cli/project-paths.js"
import { editNote, HOOK_EVENT_NAMES, isHookEvent, withNotice, withPassed } from "../hooks/hook-text.js"
import { type CopilotHookInput, parseCopilotHookInput } from "./hook-input.js"

/**
 * Exit codes as GitHub Copilot reads them: 0 reads the JSON on stdout, 2 is only a warning, and any other code is
 * logged and the agent goes on. A Copilot hook blocks through its JSON, never through its exit code.
 */
export const COPILOT_HOOK_EXIT = { pass: 0, error: 1 } as const

/** Who the hook fires for, for the metrics. The model is the last one in the session's `events.jsonl`. */
function contextOf(input: CopilotHookInput, deps: FeedbackDeps): AgentContext {
  const { sessionId, agentId, agentType, transcriptPath } = input
  const model = transcriptPath === undefined ? undefined : deps.transcriptModel({ path: transcriptPath, agentId })
  return {
    agent: "copilot",
    ...(sessionId === "" ? {} : { session: sessionId }),
    ...(agentId === undefined ? {} : { subagent: true as const }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
  }
}

/** Writes a Copilot hook's JSON output. */
function answer(io: Io, output: Record<string, string>): void {
  io.stdout(`${JSON.stringify(output)}\n`)
}

/**
 * A GitHub Copilot hook, for Copilot CLI, the GitHub Copilot app and the Copilot agent in VS Code, which share one hook
 * system. Any error exits 1: Copilot logs it and the agent goes on.
 */
export async function copilotHook(args: string[], io: Io, deps: FeedbackDeps): Promise<number> {
  try {
    const [, event, ...extra] = args
    if (!isHookEvent(event) || extra.length > 0) {
      throw new UsageError(`copilot hooks are ${HOOK_EVENT_NAMES} (got "${args.slice(1).join(" ")}")`)
    }
    const input = parseCopilotHookInput(io.stdin ? await io.stdin() : "")
    const projectDir = resolve(io.cwd, process.env.COPILOT_PROJECT_DIR || input.cwd || ".")
    const context = () => contextOf(input, deps)

    if (event === "post-edit") {
      if (input.edits.length === 0) return COPILOT_HOOK_EXIT.pass
      const cwd = input.cwd ?? io.cwd
      const linesWritten = new Map<string, number>()
      for (const { path, linesWritten: lines } of input.edits) {
        for (const file of projectFiles(cwd, projectDir, [path])) linesWritten.set(file, (linesWritten.get(file) ?? 0) + lines)
      }
      const changed = [...linesWritten.keys()]
      if (changed.length === 0) return COPILOT_HOOK_EXIT.pass
      const { report } = await afterEdit(projectDir, input, changed, deps, linesWritten, context())
      // Copilot appends it to the tool's result, so the agent reads the failures next to the edit that made them.
      if (report !== "") answer(io, { additionalContext: editNote(report) })
      return COPILOT_HOOK_EXIT.pass
    }

    // Copilot also fires agentStop when a subagent ends, before its subagentStop: subagent-stop checks its files.
    if (event === "stop" && input.agentId !== undefined) return COPILOT_HOOK_EXIT.pass
    // A subagent's stop_hook_active is not known to tell a continued stop, so each stop of a subagent continues its
    // count. The count starts again once its checks pass.
    const { decision, notice, passed } =
      event === "subagent-stop"
        ? await subagentStop(projectDir, { sessionId: input.sessionId, agentId: input.agentId, stopHookActive: true }, deps, context())
        : await mainStop(projectDir, { sessionId: input.sessionId, stopHookActive: input.stopHookActive }, deps, context())
    if (decision.action === "block") {
      // Copilot sends the reason to the agent as the next prompt.
      answer(io, { decision: "block", reason: withNotice(decision.text, notice) })
      return COPILOT_HOOK_EXIT.pass
    }
    // Copilot shows the user nothing a hook writes, so past the limit the failures go to its log with the rest.
    const failures = decision.action === "report" && event === "stop" ? decision.text : ""
    const text = withPassed(withNotice(failures, notice), event === "stop" ? passed : "")
    if (text !== "") io.stderr(`${text}\n`)
    return COPILOT_HOOK_EXIT.pass
  } catch (error) {
    reportError(error, io)
    return COPILOT_HOOK_EXIT.error
  }
}
