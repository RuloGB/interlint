import type { Check, Config, When } from "../../domain/check.js"
import type { AgentContext, CheckMetric, SkipReason } from "../../domain/metric.js"
import type { MetricsSink } from "./ports.js"
import type { CheckOutcome } from "./run-checks.js"

/** A check of the run and what it did: an outcome when it ran, or why it did not. */
export type RunEntry = { check: Check; outcome: CheckOutcome } | { check: Check; skipped: SkipReason }

/**
 * Keeps one metric for each entry of the run, unless the config turns metrics off. Never throws: a metric that cannot
 * be kept is lost, and the checks give the same either way.
 */
export function recordRun(
  projectDir: string,
  config: Config,
  when: When,
  entries: RunEntry[],
  agent: AgentContext | undefined,
  metrics: MetricsSink,
): void {
  if (config.metrics === false || entries.length === 0) return
  try {
    metrics(projectDir, entries.map((entry) => ({ ...metricOf(entry, when), ...agent })))
  } catch {
    // Lost on purpose: the checks' result never depends on their metrics.
  }
}

function metricOf(entry: RunEntry, when: When): CheckMetric {
  const { check } = entry
  const base = { when, check: check.name, report: check.report }
  if ("skipped" in entry) return { ...base, result: "skipped", skipped: entry.skipped, durationMs: 0 }
  const { outcome } = entry
  if (outcome.status !== "violations") return { ...base, result: outcome.status, durationMs: outcome.durationMs }
  // The rule and file only: a violation's text can quote the code.
  // A rule the report names without its violations counts once.
  const violations = outcome.failures.flatMap(({ title, type, violations }) =>
    (violations.length > 0 ? violations : [{ path: undefined }]).map(({ path }) => ({
      rule: title,
      ...(type === undefined ? {} : { type }),
      ...(path === undefined ? {} : { file: path }),
    })),
  )
  return { ...base, result: "violations", durationMs: outcome.durationMs, violations }
}
