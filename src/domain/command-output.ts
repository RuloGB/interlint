/**
 * How many lines of a failing team command's output the agent gets: enough for two or three failing tests of Vitest
 * or Jest, or Surefire's whole `Results:` block, without filling its context.
 */
export const COMMAND_OUTPUT_LINES = 60

/**
 * The last `max` lines of `output`, led by a line that says how many earlier ones were cut, if any. `droppedLines`
 * were already left out before `output`, and count as cut too.
 */
export function outputTail(output: string, max = COMMAND_OUTPUT_LINES, droppedLines = 0): string {
  const lines = output.trimEnd().split(/\r?\n/)
  const cut = Math.max(0, lines.length - max) + droppedLines
  if (cut === 0) return lines.join("\n")
  return [`… ${cut} earlier lines cut`, ...lines.slice(-max)].join("\n")
}
