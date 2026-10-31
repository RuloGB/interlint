import type { AgentRef, StopCounter } from "./ports.js"

/** The same limit as the OpenCode plugin. */
export const MAX_CONSECUTIVE_BLOCKS = 3

export type StopDecision = { action: "end" } | { action: "block"; text: string } | { action: "report"; text: string }

export interface StopRequest extends AgentRef {
  /** Whether the agent is already continuing because a stop was blocked. */
  stopHookActive: boolean
}

/**
 * Decides what a stop does with the task-end report, empty when every check passed.
 * The blocks in a row are counted per session, and per subagent for a subagent's stop.
 * A stop that the agent did not reach by continuing after a blocked stop starts a new count.
 * Past the limit the count stays, so stops in the same row (another stop hook may keep
 * the agent going) end quietly instead of blocking again.
 */
export function decideStop(request: StopRequest, report: string, counter: StopCounter): StopDecision {
  if (report === "") {
    counter.clear(request)
    return { action: "end" }
  }

  const attempt = (request.stopHookActive ? counter.read(request) : 0) + 1
  counter.save(request, attempt)
  if (attempt === MAX_CONSECUTIVE_BLOCKS + 1) {
    return {
      action: "report",
      text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${report}`,
    }
  }
  if (attempt > MAX_CONSECUTIVE_BLOCKS) return { action: "end" }
  // A subagent that answers with a question instead of a fix only spends an attempt: nobody answers it.
  const forSubagent = request.agentId === undefined ? "" : SUBAGENT_BLOCK_NOTE
  return {
    action: "block",
    text: `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${forSubagent}${report}`,
  }
}

/** The same words as the OpenCode plugin's. */
const SUBAGENT_BLOCK_NOTE = `Fix these failures yourself before you answer: asking how to proceed does not end the task. After ${MAX_CONSECUTIVE_BLOCKS} attempts they go to the agent that delegated this work.\n\n`
