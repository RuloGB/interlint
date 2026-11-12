import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { MetricsQuery } from "../../../application/metrics/show-metrics.js"
import {
  type MetricsDeps,
  REPORT_FORMATS,
  type ReportFormat,
  showMetrics,
  writeMetricsReport,
} from "../../../application/metrics/show-metrics.js"
import { EXIT, type Io, UsageError, UserFacingError } from "./cli-io.js"

const AGENTS = ["claude-code", "copilot", "opencode"]

/** The default report file, in the project's folder, with the format as its extension (decision 48). */
export const REPORT_NAME = "interlint-metrics"

/** `interlint metrics` and `interlint metrics report`: they only read the metrics, so they never fail a check. */
export function metrics(args: string[], io: Io, deps: MetricsDeps): number {
  const { values, positionals } = parseMetricsArgs(args)
  const [subcommand, ...extra] = positionals
  if (extra.length > 0 || (subcommand !== undefined && subcommand !== "report")) {
    throw new UsageError(`unknown metrics command "${positionals.join(" ")}"`)
  }
  const report = subcommand === "report"
  if (!report && values.out !== undefined) throw new UsageError("--out is only valid with metrics report")
  if (!report && values.force === true) throw new UsageError("--force is only valid with metrics report")
  if (!report && values.format !== undefined) throw new UsageError("--format is only valid with metrics report")
  const format = formatOf(values.format)

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const query: MetricsQuery = {
    scope: values.all === true ? { all: true } : { projectDir },
    since: sinceOf(values.since),
    agent: agentOf(values.agent),
  }
  if (!report) {
    io.stdout(`${showMetrics(query, deps)}\n`)
    return EXIT.passed
  }
  const path = values.out === undefined ? resolve(projectDir, `${REPORT_NAME}.${format}`) : resolve(io.cwd, values.out)
  const outcome = writeMetricsReport(query, { path, format, force: values.force === true }, deps)
  if (outcome.status === "exists") throw new UserFacingError(`${path} already exists. Use --force to replace it.`)
  if (outcome.status === "no-pdf") {
    throw new UserFacingError(`could not write a PDF: ${outcome.reason}. Use --format html and print it to PDF from a browser.`)
  }
  io.stdout(`${outcome.text}\n`)
  return EXIT.passed
}

function sinceOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // A date that does not exist, such as 2026-02-30, comes back as another day.
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
  if (!valid) throw new UsageError(`--since must be a date as YYYY-MM-DD (got "${value}")`)
  return value
}

function formatOf(value: string | undefined): ReportFormat {
  if (value === undefined) return "md"
  if (!(REPORT_FORMATS as readonly string[]).includes(value)) {
    throw new UsageError(`--format must be md, html or pdf (got "${value}")`)
  }
  return value as ReportFormat
}

function agentOf(value: string | undefined): string | undefined {
  if (value !== undefined && !AGENTS.includes(value)) {
    throw new UsageError(`--agent must be ${AGENTS.slice(0, -1).join(", ")} or ${AGENTS.at(-1)} (got "${value}")`)
  }
  return value
}

function parseMetricsArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        cwd: { type: "string" },
        all: { type: "boolean" },
        since: { type: "string" },
        agent: { type: "string" },
        out: { type: "string" },
        force: { type: "boolean" },
        format: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
