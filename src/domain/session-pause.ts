/** What the user asks with a mark in their prompt: to pause Interlint in the session, or to resume it. */
export type PauseMark = "pause" | "resume"

/** The marks as the user writes them, in any case, anywhere in the prompt. */
const MARK = /interlint:[ \t]*(pause|resume)(?![\p{L}\p{N}_-])/giu

/**
 * The mark in a user's prompt: the last one when it holds both, as the user's latest word. None without a mark.
 * Only the exact mark counts: the prompt is not interpreted.
 */
export function pauseMarkOf(prompt: string): PauseMark | undefined {
  let mark: PauseMark | undefined
  for (const match of prompt.matchAll(MARK)) mark = match[1]!.toLowerCase() as PauseMark
  return mark
}

/** What the user reads when a mark paused Interlint. The same words as the OpenCode plugin's. */
export const PAUSED_MESSAGE = "Interlint is paused in this session."

/** What the user reads when a mark resumed Interlint. The same words as the OpenCode plugin's. */
export const RESUMED_MESSAGE = "Interlint is active again in this session."

/** What the user reads when they resume a session that was not paused. The same words as the OpenCode plugin's. */
export const NOT_PAUSED_MESSAGE = "Interlint is not paused in this session."

/** What the user reads at each task end of the main agent while Interlint is paused. The same words as the OpenCode plugin's. */
export const PAUSED_REMINDER = "ℹ Interlint · paused in this session."

/**
 * The advice the user reads after the main agent's last attempt, never the agent: it would only ask the user whether
 * to pause instead of fixing. The same words as the OpenCode plugin's.
 */
export const PAUSE_ADVICE = 'Write "interlint: pause" to pause Interlint in this session, and "interlint: resume" to turn it back on.'
