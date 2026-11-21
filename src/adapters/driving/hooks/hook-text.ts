/** The texts the agent hooks give, the same for every agent that runs them. */

/** Every event an agent hook command can take. */
const ALL_HOOK_EVENTS = ["session-start", "user-prompt", "pre-edit", "post-edit", "stop", "subagent-start", "subagent-stop"] as const
export type HookEvent = (typeof ALL_HOOK_EVENTS)[number]

/** The events of Claude Code's hook command. */
export const CLAUDE_CODE_HOOK_EVENTS: readonly HookEvent[] = ALL_HOOK_EVENTS

/** The events of Codex's hook command: its hooks cannot ask the user, so it has no `pre-edit`. */
export const CODEX_HOOK_EVENTS: readonly HookEvent[] = ALL_HOOK_EVENTS.filter((event) => event !== "pre-edit")

/** The events of Copilot's hook command. */
export const COPILOT_HOOK_EVENTS: readonly HookEvent[] = ALL_HOOK_EVENTS

/** The events as words, such as `session-start, post-edit, stop and subagent-stop`. */
export function hookEventNames(events: readonly HookEvent[]): string {
  return `${events.slice(0, -1).join(", ")} and ${events.at(-1)}`
}

/** Whether `event` is one of `events`, the events of one agent's hook command. */
export function isHookEvent(event: string | undefined, events: readonly HookEvent[]): event is HookEvent {
  return (events as readonly (string | undefined)[]).includes(event)
}

/** What the post-edit hook sends to the agent when the checks fail. */
export function editNote(report: string): string {
  return `Interlint: the checks fail after this edit.\n\n${report}`
}

/** What the post-edit hook shows the user when the checks fail, for agents that show the user none of what the agent gets. */
export function failedLine(failed: string[]): string {
  return `✗ Interlint · checks failed after this edit: ${failed.join(", ")}`
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
