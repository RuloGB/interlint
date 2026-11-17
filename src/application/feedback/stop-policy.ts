import { PROTECTED_CHECK } from "../../domain/protected-files.js"
import { PAUSE_ADVICE } from "../../domain/session-pause.js"
import type { AgentRef, StopCounter } from "./ports.js"

/** The same limit as the OpenCode plugin. */
export const MAX_CONSECUTIVE_BLOCKS = 3

export type StopDecision = { action: "end" } | { action: "block"; text: string } | { action: "report"; text: string }

export interface StopRequest extends AgentRef {
  /** Whether the agent is already continuing because a stop was blocked. */
  stopHookActive: boolean
}

/**
 * Decides what a stop does with the task-end report, empty when every check passed. `failed` names the checks in it.
 * The blocks in a row are counted per session, and per subagent for a subagent's stop.
 * A stop that the agent did not reach by continuing after a blocked stop starts a new count.
 * Only the main agent's report past the limit, which only the user reads, advises pausing Interlint (F26).
 * Past the limit the count stays, so stops in the same row (another stop hook may keep
 * the agent going) end quietly instead of blocking again.
 */
export function decideStop(
  request: StopRequest,
  report: string,
  failed: readonly string[],
  counter: StopCounter,
): StopDecision {
  if (report === "") {
    counter.clear(request)
    return { action: "end" }
  }

  const attempt = (request.stopHookActive ? counter.read(request) : 0) + 1
  counter.save(request, attempt)
  if (attempt === MAX_CONSECUTIVE_BLOCKS + 1) {
    return {
      action: "report",
      text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${withPauseAdvice(request, report)}`,
    }
  }
  if (attempt > MAX_CONSECUTIVE_BLOCKS) return { action: "end" }
  return {
    action: "block",
    text: `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${blockNote(request, failed)}${report}`,
  }
}

/** The report with the advice to pause Interlint after it, on its own paragraph. A subagent's report gets none. */
function withPauseAdvice(request: StopRequest, report: string): string {
  return request.agentId === undefined ? `${report.trimEnd()}

${PAUSE_ADVICE}
` : report
}

/**
 * What a blocked agent is told before the failures. An agent that answers with a question instead of a fix only
 * spends an attempt: nobody answers a subagent, and a main agent told to change nothing else asks before it fixes.
 * The protected files' failure says what to do itself, which may be to ask the user: alone it gets no note, and next
 * to a failed check the note leaves it apart.
 */
function blockNote(request: StopRequest, failed: readonly string[]): string {
  if (request.agentId !== undefined) return SUBAGENT_BLOCK_NOTE
  if (!failed.some((name) => name !== PROTECTED_CHECK)) return ""
  return `${MAIN_BLOCK_NOTE}${failed.includes(PROTECTED_CHECK) ? PROTECTED_APART_NOTE : ""}\n\n`
}

/** The same words as the OpenCode plugin's. */
const SUBAGENT_BLOCK_NOTE = `Fix these failures yourself before you answer: asking how to proceed does not end the task. After ${MAX_CONSECUTIVE_BLOCKS} attempts they go to the agent that delegated this work.\n\n`

/** The same words as the OpenCode plugin's. */
const MAIN_BLOCK_NOTE =
  "Fix these failures before you answer: they are in the projects this task changed, so fixing them is part of the task, even if you were asked to change nothing else. Asking the user whether to fix them does not end the task."

/** The same words as the OpenCode plugin's. */
const PROTECTED_APART_NOTE = " The protected files are a separate case: follow the instructions in their own message."
