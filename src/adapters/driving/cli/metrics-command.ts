import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { MetricsQuery } from "../../../application/metrics/show-metrics.js"
import { type MetricsDeps, showMetrics, writeMetricsReport } from "../../../application/metrics/show-metrics.js"
import { EXIT, type Io, UsageError, UserFacingError } from "./cli-io.js"

const AGENTS = ["claude-code", "opencode"]

/** The default report file, in the project's folder (decision 48). */
export const REPORT_FILE = "interlint-metrics.md"

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
  const path = values.out === undefined ? resolve(projectDir, REPORT_FILE) : resolve(io.cwd, values.out)
  const outcome = writeMetricsReport(query, path, values.force === true, deps)
  if (outcome.status === "exists") throw new UserFacingError(`${path} already exists. Use --force to replace it.`)
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

function agentOf(value: string | undefined): string | undefined {
  if (value !== undefined && !AGENTS.includes(value)) {
    throw new UsageError(`--agent must be ${AGENTS.join(" or ")} (got "${value}")`)
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
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
