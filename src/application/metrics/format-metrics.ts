import type { MetricsSummary, Tally } from "../../domain/metric-summary.js"
import { duration, plural, ratio, sum } from "./figures.js"
import { mermaid } from "./mermaid.js"
import { reportOf } from "./report.js"

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

/** The full report in Markdown, with Mermaid charts: to keep, share or paste into a pull request. */
export function formatReport(summary: MetricsSummary, unreadable: number, filters: string[], generated: Date): string {
  const report = reportOf(summary, skippedLines(unreadable), filters, generated)
  const sections = [
    `# Interlint metrics\n\n${[
      `- Projects: ${report.projects.map(cell).join(", ")}`,
      `- Period: ${report.from} to ${report.to} (UTC)`,
      ...(filters.length > 0 ? [`- Filtered by ${filters.map((filter) => `\`${filter}\``).join(", ")}`] : []),
      `- Generated on ${report.generated}`,
    ].join("\n")}`,
    ...report.sections.map(({ title, charts, table: { headers, rows }, note }) =>
      [`## ${title}`, ...charts.map(mermaid), table(headers, rows), ...(note === undefined ? [] : [note])].join("\n\n"),
    ),
  ]
  return `${sections.join("\n\n")}\n${report.notes === "" ? "" : `\n${report.notes}\n`}`
}

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

function sessionsLine(summary: MetricsSummary): string {
  const { sessions } = summary
  if (sessions.length === 0) return "Sessions: none, the checks ran by hand"
  const checks = sessions.map((session) => session.checks)
  return `Sessions: ${sessions.length}, ${ratio(sum(checks), sessions.length, 1)} checks run on average, ${Math.max(...checks)} at most`
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
