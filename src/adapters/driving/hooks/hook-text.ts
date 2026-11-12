/** The texts the agent hooks give, the same for every agent that runs them. */

/** The events every agent hook command takes. */
export const HOOK_EVENTS = ["post-edit", "stop", "subagent-stop"] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** `post-edit, stop and subagent-stop`. */
export const HOOK_EVENT_NAMES = `${HOOK_EVENTS.slice(0, -1).join(", ")} and ${HOOK_EVENTS.at(-1)}`

export function isHookEvent(event: string | undefined): event is HookEvent {
  return (HOOK_EVENTS as readonly (string | undefined)[]).includes(event)
}

/** What the post-edit hook sends to the agent when the checks fail. */
export function editNote(report: string): string {
  return `Interlint: the checks fail after this edit.\n\n${report}`
}

export function withNotice(text: string, notice: string): string {
  if (notice === "") return text
  return text === "" ? notice : `${text.trimEnd()}\n\n${notice}`
}

/** The text with the line of the checks that passed after it, on its own line. */
export function withPassed(text: string, passed: string): string {
  if (passed === "") return text
  return text === "" ? passed.trimEnd() : `${text.trimEnd()}\n${passed.trimEnd()}`
}
