import type { MetricEvent } from "../../domain/metric.js"
import { type MetricsSummary, summarize } from "../../domain/metric-summary.js"
import { formatReport, formatSummary, skippedLines } from "./format-metrics.js"
import type { MetricsScope, MetricsSource, ReportFile } from "./ports.js"

export interface MetricsDeps {
  source: MetricsSource
  reportFile: ReportFile
  now: () => Date
}

/** Which metrics to sum up: a scope, and the filters the user gave. */
export interface MetricsQuery {
  scope: MetricsScope
  /** `YYYY-MM-DD`: events from that day on, in UTC. */
  since?: string
  agent?: string
}

export type ReportOutcome = { status: "written"; text: string } | { status: "exists" } | { status: "empty"; text: string }

/** The terminal summary of the metrics, or why there is none. */
export function showMetrics(query: MetricsQuery, deps: MetricsDeps): string {
  const selected = select(query, deps)
  return "summary" in selected ? formatSummary(selected.summary, selected.unreadable, filtersOf(query)) : selected.text
}

/**
 * Writes the Markdown report to `path`. An existing file is replaced only with `force`; with no metrics, nothing is
 * written.
 */
export function writeMetricsReport(query: MetricsQuery, path: string, force: boolean, deps: MetricsDeps): ReportOutcome {
  const selected = select(query, deps)
  if (!("summary" in selected)) return { status: "empty", text: selected.text }
  if (!force && deps.reportFile.exists(path)) return { status: "exists" }
  deps.reportFile.write(path, formatReport(selected.summary, selected.unreadable, filtersOf(query), deps.now()))
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
