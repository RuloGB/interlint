/**
 * How many lines of a failing team command's output the agent gets: enough for two or three failing tests of Vitest
 * or Jest, or Surefire's whole `Results:` block, without filling its context.
 */
export const COMMAND_OUTPUT_LINES = 60

/** The last `max` lines of `output`, led by a line that says how many earlier ones were cut, if any. */
export function outputTail(output: string, max = COMMAND_OUTPUT_LINES): string {
  const lines = output.trimEnd().split(/\r?\n/)
  if (lines.length <= max) return lines.join("\n")
  return [`… ${lines.length - max} earlier lines cut`, ...lines.slice(-max)].join("\n")
}
