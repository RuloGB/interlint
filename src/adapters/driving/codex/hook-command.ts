import { resolve } from "node:path"
import { afterEdit, type FeedbackDeps, mainStop, sessionStart, subagentStop } from "../../../application/feedback/agent-events.js"
import type { AgentContext } from "../../../domain/metric.js"
import { type Io, reportError, UsageError } from "../cli/cli-io.js"
import { projectFiles } from "../cli/project-paths.js"
import { CODEX_HOOK_EVENTS, editNote, failedLine, hookEventNames, isHookEvent, withNotice, withPassed } from "../hooks/hook-text.js"
import { type CodexHookInput, parseCodexHookInput } from "./hook-input.js"

/**
 * Exit codes as Codex reads them: 0 reads the JSON on stdout. Interlint blocks through that JSON, never through exit
 * code 2, so an error of its own never keeps the agent going.
 */
export const CODEX_HOOK_EXIT = { pass: 0, error: 1 } as const

/** Why post-edit ran no check for an `apply_patch` whose input it could not read. */
const UNREADABLE_PATCH = "the apply_patch input has no patch in tool_input.command, so no check ran for this edit"

/** Who the hook fires for, for the metrics. Codex gives the model in the input itself. */
function contextOf({ sessionId, agentId, agentType, model }: CodexHookInput): AgentContext {
  return {
    agent: "codex",
    ...(sessionId === "" ? {} : { session: sessionId }),
    ...(agentId === undefined ? {} : { subagent: true as const }),
    ...(agentType === undefined ? {} : { agentType }),
    ...(model === undefined ? {} : { model }),
  }
}

/** Writes a Codex hook's JSON output. Codex rejects plain text on stdout when the hook exits 0. */
function answer(io: Io, output: Record<string, unknown>): void {
  io.stdout(`${JSON.stringify(output)}\n`)
}

/** Shows the text to the user only. Nothing when it is empty. */
function tellUser(io: Io, text: string): void {
  if (text !== "") answer(io, { systemMessage: text })
}

/** A Codex hook, from `.codex/hooks.json`. Any error exits 1, never 2: Codex would read 2 as a block. */
export async function codexHook(args: string[], io: Io, deps: FeedbackDeps): Promise<number> {
  try {
    const [, event, ...extra] = args
    if (!isHookEvent(event, CODEX_HOOK_EVENTS) || extra.length > 0) {
      throw new UsageError(`codex hooks are ${hookEventNames(CODEX_HOOK_EVENTS)} (got "${args.slice(1).join(" ")}")`)
    }
    const input = parseCodexHookInput(io.stdin ? await io.stdin() : "")
    // Codex sets no variable with the project's directory: it runs the hook in the session's working directory.
    const projectDir = resolve(io.cwd, input.cwd ?? ".")
    const context = contextOf(input)

    // Codex also starts it for each subagent, with the session's ID: the fingerprint is kept only once.
    if (event === "session-start") {
      sessionStart(projectDir, context, deps)
      return CODEX_HOOK_EXIT.pass
    }

    if (event === "post-edit") {
      // Codex may have changed its input: say why no check ran, rather than skip the edit without a trace.
      if (input.unreadablePatch) io.stderr(`interlint: ${UNREADABLE_PATCH}
`)
      if (input.edits.length === 0) return CODEX_HOOK_EXIT.pass
      const linesWritten = new Map<string, number>()
      for (const { path, linesWritten: lines } of input.edits) {
        for (const file of projectFiles(projectDir, projectDir, [path])) linesWritten.set(file, (linesWritten.get(file) ?? 0) + lines)
      }
      const changed = [...linesWritten.keys()]
      if (changed.length === 0) return CODEX_HOOK_EXIT.pass
      // One run for every file of the patch, as one edit would.
      const { report, passed, failed } = await afterEdit(projectDir, input, changed, deps, linesWritten, context)
      if (report !== "") {
        // Developer context next to the patch's result, which stays as it was, and a line for the user.
        answer(io, {
          systemMessage: failedLine(failed),
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: editNote(report) },
        })
        return CODEX_HOOK_EXIT.pass
      }
      tellUser(io, withPassed("", passed))
      return CODEX_HOOK_EXIT.pass
    }

    const { decision, notice, passed } =
      event === "subagent-stop"
        ? await subagentStop(projectDir, input, deps, context)
        : await mainStop(projectDir, input, deps, context)
    if (decision.action === "block") {
      // Codex sends the reason to the agent as a new prompt to continue.
      answer(io, { decision: "block", reason: withNotice(decision.text, notice) })
      return CODEX_HOOK_EXIT.pass
    }
    // Past the limit the task may end, and the user still sees the failures.
    const failures = decision.action === "report" && event === "stop" ? decision.text : ""
    tellUser(io, withPassed(withNotice(failures, notice), event === "stop" ? passed : ""))
    return CODEX_HOOK_EXIT.pass
  } catch (error) {
    reportError(error, io)
    return CODEX_HOOK_EXIT.error
  }
}
