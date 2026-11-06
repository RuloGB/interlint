import type { MetricsSummary, Tally } from "../../domain/metric-summary.js"

/** The note on the lines that are not events, or nothing when every line was one. */
export function skippedLines(unreadable: number): string {
  if (unreadable === 0) return ""
  return unreadable === 1
    ? "Skipped 1 line that is not a metrics event."
    : `Skipped ${unreadable} lines that are not metrics events.`
}

/** The short summary for the terminal: read in seconds. */
export function formatSummary(summary: MetricsSummary, unreadable: number, filters: string[]): string {
  const lines = [heading(summary)]
  if (filters.length > 0) lines.push(`Filtered by ${filters.join(", ")}`)
  lines.push(
    "",
    `Checks run: ${summary.checksRun} (${summary.skipped} skipped) · violations: ${summary.violations}`,
    `By type: ${summary.byType.map(({ type, violations }) => `${type} ${violations}`).join(" · ") || "none"}`,
  )
  const top = summary.rules.slice(0, 5)
  if (top.length > 0) {
    const width = Math.max(...top.map((rule) => String(rule.violations).length))
    const typeWidth = Math.max(...top.map((rule) => rule.type.length))
    lines.push("Top rules:", ...top.map((rule) => `  ${String(rule.violations).padStart(width)}  ${rule.type.padEnd(typeWidth)}  ${rule.rule}`))
  }
  lines.push(
    "",
    "By model (violations per check run):",
    ...tallyLines(summary.byModel),
    "By agent (violations per check run):",
    ...tallyLines(summary.byAgent),
    "",
    sessionsLine(summary),
    `Task-end blocks: ${summary.blocks}, ${summary.fixed} fixed later in the session`,
    `Time spent on checks: ${duration(summary.waitMs)}`,
  )
  const notes = skippedLines(unreadable)
  if (notes !== "") lines.push("", notes)
  return lines.join("\n")
}

/** The full report in Markdown: to keep, share or paste into a pull request. */
export function formatReport(summary: MetricsSummary, unreadable: number, filters: string[], generated: Date): string {
  const sessions = summary.sessions
  const sections = [
    `# Interlint metrics\n\n${[
      `- Projects: ${summary.projects.map(cell).join(", ")}`,
      `- Period: ${summary.from} to ${summary.to} (UTC)`,
      ...(filters.length > 0 ? [`- Filtered by ${filters.map((filter) => `\`${filter}\``).join(", ")}`] : []),
      `- Generated on ${generated.toISOString().slice(0, 10)}`,
    ].join("\n")}`,
    section(
      "Totals",
      table(
        ["Checks run", "Skipped", "Violations", "Sessions", "Task-end blocks", "Fixed", "Time spent on checks"],
        [[summary.checksRun, summary.skipped, summary.violations, sessions.length, summary.blocks, summary.fixed, duration(summary.waitMs)]],
      ),
      "A violation counts once in every run that shows it. Skipped checks are not counted as run.",
    ),
    section("Violations by type", table(["Type", "Violations"], summary.byType.map(({ type, violations }) => [type, violations]))),
    section(
      "Top 20 rules",
      table(["Violations", "Type", "Rule"], summary.rules.slice(0, 20).map(({ violations, type, rule }) => [violations, type, rule])),
    ),
    section("By model", tallyTable("Model", summary.byModel), NORMALIZED),
    section("By agent", tallyTable("Agent", summary.byAgent), NORMALIZED),
    section(
      "Sessions",
      table(
        ["Session", "Agent", "Model", "Checks run", "Violations", "Blocks", "Fixed", "Ended green"],
        sessions.map((s) => [s.session, s.agent, s.model, s.checks, s.violations, s.blocks, s.fixed, green(s.endedGreen)]),
      ),
      sessions.length === 0
        ? "No checks ran in an agent's session."
        : `${ratio(sum(sessions.map((s) => s.checks)), sessions.length, 1)} checks run per session on average, ${Math.max(...sessions.map((s) => s.checks))} at most.`,
    ),
    section(
      "Task-end blocks",
      table(
        ["Model", "Blocks", "Fixed", "Fix rate"],
        summary.blocksByModel.map(({ name, blocks, fixed }) => [name, blocks, fixed, `${Math.round((fixed / blocks) * 100)}%`]),
      ),
      "A block is a task end in an agent's session where a check did not pass. It is fixed when a later task end of the same session passes.",
    ),
    section(
      "Time spent on checks",
      table(
        ["Check", "Moment", "Runs", "Total", "Average"],
        summary.waitByCheck.map(({ check, when, runs, totalMs }) => [check, when, runs, duration(totalMs), duration(totalMs / runs)]),
      ),
    ),
    section(
      "Over time",
      table(["Week of", "Checks run", "Violations"], summary.byWeek.map(({ week, checks, violations }) => [week, checks, violations])),
      "Weeks start on Monday, in UTC.",
    ),
  ]
  const notes = skippedLines(unreadable)
  return `${sections.join("\n\n")}\n${notes === "" ? "" : `\n${notes}\n`}`
}

const NORMALIZED =
  "Compare by violations per check run: a model used more has more violations. Sessions and checks run say how much is behind each figure."

function heading(summary: MetricsSummary): string {
  const projects = summary.projects.length === 1 ? summary.projects[0] : `${summary.projects.length} projects`
  return `Interlint metrics · ${projects} · ${summary.from} to ${summary.to}`
}

function tallyLines(tallies: Tally[]): string[] {
  const width = Math.max(...tallies.map((tally) => tally.name.length))
  return tallies.map(
    (tally) =>
      `  ${tally.name.padEnd(width)}  ${ratio(tally.violations, tally.checks, 2).padStart(5)}  (${plural(tally.checks, "check")}, ${plural(tally.sessions, "session")})`,
  )
}

function tallyTable(label: string, tallies: Tally[]): string {
  return table(
    [label, "Sessions", "Checks run", "Violations", "Violations per check run"],
    tallies.map((tally) => [tally.name, tally.sessions, tally.checks, tally.violations, ratio(tally.violations, tally.checks, 2)]),
  )
}

function sessionsLine(summary: MetricsSummary): string {
  const { sessions } = summary
  if (sessions.length === 0) return "Sessions: none, the checks ran by hand"
  const checks = sessions.map((session) => session.checks)
  return `Sessions: ${sessions.length}, ${ratio(sum(checks), sessions.length, 1)} checks run on average, ${Math.max(...checks)} at most`
}

function section(title: string, body: string, note?: string): string {
  return [`## ${title}`, body, ...(note === undefined ? [] : [note])].join("\n\n")
}

function table(headers: string[], rows: (string | number)[][]): string {
  if (rows.length === 0) return "None."
  const line = (cells: (string | number)[]) => `| ${cells.map((value) => cell(String(value))).join(" | ")} |`
  return [line(headers), `|${headers.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n")
}

/** A table cell: a `|` or a line break in a rule name would break the table. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\r?\n/g, " ")
}

function green(ended: boolean | undefined): string {
  return ended === undefined ? "no task end" : ended ? "yes" : "no"
}

function ratio(part: number, whole: number, digits: number): string {
  return whole === 0 ? "-" : (part / whole).toFixed(digits)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** A duration as people read it: `4.5s`, `2m 5s`, `1h 3m`. */
export function duration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`
}
