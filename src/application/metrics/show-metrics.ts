import type { MetricEvent } from "../../domain/metric.js"
import { type MetricsSummary, summarize } from "../../domain/metric-summary.js"
import { formatReport, formatSummary, skippedLines } from "./format-metrics.js"
import { formatHtmlReport } from "./html-report.js"
import type { MetricsScope, MetricsSource, PdfPrinter, ReportFile } from "./ports.js"

export interface MetricsDeps {
  source: MetricsSource
  reportFile: ReportFile
  pdf: PdfPrinter
  now: () => Date
}

/** Which metrics to sum up: a scope, and the filters the user gave. */
export interface MetricsQuery {
  scope: MetricsScope
  /** `YYYY-MM-DD`: events from that day on, in UTC. */
  since?: string
  agent?: string
}

export const REPORT_FORMATS = ["md", "html", "pdf"] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

/** Where and how to write the report. */
export interface ReportRequest {
  path: string
  format: ReportFormat
  /** Replaces an existing file. */
  force: boolean
}

export type ReportOutcome =
  | { status: "written"; text: string }
  | { status: "exists" }
  | { status: "empty"; text: string }
  /** The PDF could not be printed, for `reason`. */
  | { status: "no-pdf"; reason: string }

/** The terminal summary of the metrics, or why there is none. */
export function showMetrics(query: MetricsQuery, deps: MetricsDeps): string {
  const selected = select(query, deps)
  return "summary" in selected ? formatSummary(selected.summary, selected.unreadable, filtersOf(query)) : selected.text
}

/**
 * Writes the report to `path` in Markdown, HTML, or as a PDF printed from the HTML. An existing file is replaced only
 * with `force`; with no metrics, nothing is written.
 */
export function writeMetricsReport(query: MetricsQuery, { path, format, force }: ReportRequest, deps: MetricsDeps): ReportOutcome {
  const selected = select(query, deps)
  if (!("summary" in selected)) return { status: "empty", text: selected.text }
  if (!force && deps.reportFile.exists(path)) return { status: "exists" }
  const render = format === "md" ? formatReport : formatHtmlReport
  const content = render(selected.summary, selected.unreadable, filtersOf(query), deps.now())
  if (format === "pdf") {
    const result = deps.pdf.print(content, path)
    if (!result.printed) return { status: "no-pdf", reason: result.reason }
  } else {
    deps.reportFile.write(path, content)
  }
  return { status: "written", text: [`Wrote the metrics report to ${path}`, skippedLines(selected.unreadable)].filter(Boolean).join("\n") }
}

type Selected = { summary: MetricsSummary; unreadable: number } | { text: string }

function select(query: MetricsQuery, deps: MetricsDeps): Selected {
  const { events, unreadable } = deps.source.read(query.scope)
  const notes = skippedLines(unreadable)
  if (events.length === 0) {
    return { text: [`No metrics yet. Interlint keeps them in ${deps.source.location(query.scope)}.`, notes].filter(Boolean).join("\n") }
  }
  const kept = events.filter((event) => matches(event, query))
  if (kept.length === 0) return { text: [`No metrics match ${filtersOf(query).join(" ")}.`, notes].filter(Boolean).join("\n") }
  return { summary: summarize(kept), unreadable }
}

function matches(event: MetricEvent, query: MetricsQuery): boolean {
  if (query.since !== undefined && event.at < `${query.since}T00:00:00.000Z`) return false
  return query.agent === undefined || event.agent === query.agent
}

/** The filters as the user typed them, to repeat them back. */
function filtersOf(query: MetricsQuery): string[] {
  return [
    ...(query.since === undefined ? [] : [`--since ${query.since}`]),
    ...(query.agent === undefined ? [] : [`--agent ${query.agent}`]),
  ]
}
