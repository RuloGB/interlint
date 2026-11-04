/**
 * How many lines of `after` an edit wrote over `before`: those not matched by a line of `before`, each line of
 * `before` matching once. The lines an edit keeps around its change do not count, and neither do the ones it removes.
 * For a new file, `before` is empty and every line counts.
 */
export function writtenLines(before: string, after: string): number {
  const kept = new Map<string, number>()
  for (const line of linesOf(before)) kept.set(line, (kept.get(line) ?? 0) + 1)
  let written = 0
  for (const line of linesOf(after)) {
    const left = kept.get(line) ?? 0
    if (left > 0) kept.set(line, left - 1)
    else written++
  }
  return written
}

/** The lines of `text`, without their endings. A final line ending does not start another line. */
function linesOf(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r?\n/)
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines
}
