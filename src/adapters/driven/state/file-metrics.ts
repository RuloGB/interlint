import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { MetricsSink } from "../../../application/checking/ports.js"
import type { MetricsRead, MetricsScope, MetricsSource } from "../../../application/metrics/ports.js"
import type { SessionMetrics } from "../../../application/feedback/ports.js"
import { isSessionMetricLine, METRICS_FORMAT_VERSION, metricEventOf } from "../../../domain/metric.js"
import { interlintVersion } from "./interlint-version.js"
import { projectKey, userStateDir } from "./user-state.js"

/** Where the metrics of every project are kept, unless a test gives its own directory. */
function metricsDir(stateDir: string | undefined): string {
  return stateDir ?? join(userStateDir(), "interlint", "metrics")
}

/**
 * Keeps metrics as JSON Lines, one line per check, in `<stateDir>/<projectKey>/<YYYY-MM>.jsonl`: one file per project
 * and per month (UTC), only ever appended to and never removed (decision 39). Plain text: they are the user's data on
 * the user's machine (decision 32). A line keeps the project's folder name, not its path, which may name a client
 * (decision 40). Any error loses the metrics and throws nothing.
 */
export function fileMetrics(stateDir?: string, now: () => Date = () => new Date()): MetricsSink {
  return (projectDir, metrics) => appendLines(stateDir, now, projectDir, metrics)
}

/** Keeps a session's pause or resume (F26) as a line of its own in the same files as the checks' metrics. */
export function fileSessionMetrics(stateDir?: string, now: () => Date = () => new Date()): SessionMetrics {
  return (projectDir, metric) => appendLines(stateDir, now, projectDir, [metric])
}

function appendLines(stateDir: string | undefined, now: () => Date, projectDir: string, records: readonly object[]): void {
  if (records.length === 0) return
  try {
    const at = now().toISOString()
    const key = projectKey(projectDir)
    const envelope = { v: METRICS_FORMAT_VERSION, at, interlint: interlintVersion(), projectKey: key, project: basename(resolve(projectDir)) }
    const dir = join(metricsDir(stateDir), key)
    // Only the user may read the metrics.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // One write for the whole run, made under the project lock, so two runs never mix their lines.
    const lines = records.map((record) => `${JSON.stringify({ ...envelope, ...record })}
`).join("")
    appendFileSync(join(dir, `${at.slice(0, 7)}.jsonl`), lines)
  } catch {
    // Lost on purpose: a metric never changes what the checks give.
  }
}

/**
 * Reads the metrics `fileMetrics` keeps, month by month. A line that is not an event is counted and left out, and a
 * file or directory that cannot be read gives nothing: the metrics are never worth an error.
 */
export function fileMetricsSource(stateDir?: string): MetricsSource {
  const location = (scope: MetricsScope) =>
    "all" in scope ? metricsDir(stateDir) : join(metricsDir(stateDir), projectKey(scope.projectDir))
  return {
    location,
    read(scope) {
      const dirs = "all" in scope ? entries(location(scope)).map((key) => join(location(scope), key)) : [location(scope)]
      const read: MetricsRead = { events: [], unreadable: 0 }
      for (const dir of dirs) {
        for (const file of entries(dir).filter((name) => name.endsWith(".jsonl"))) readLines(join(dir, file), read)
      }
      read.events.sort((a, b) => a.at.localeCompare(b.at))
      return read
    },
  }
}

/** The names in a directory, sorted, or none when it cannot be read. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function readLines(file: string, read: MetricsRead): void {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const value = parse(line)
    // A session's pause or resume is no check's metric, and no unreadable line either.
    if (isSessionMetricLine(value)) continue
    const event = metricEventOf(value)
    if (event === undefined) read.unreadable++
    else read.events.push(event)
  }
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
