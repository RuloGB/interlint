import type { Report, When } from "./check.js"
import type { RuleType } from "./violation.js"

/**
 * Who ran the checks, as the agent integrations tell it. Every field is absent when the checks ran by hand, or when
 * the agent does not give it (decision 36).
 */
export interface AgentContext {
  /** `claude-code` or `opencode`. */
  agent?: string
  session?: string
  /** Present, as true, only when a subagent ran the checks. */
  subagent?: true
  /** The kind of subagent, such as `Explore`. */
  agentType?: string
  /** The model's ID as the agent gives it. */
  model?: string
  /** Who serves the model, as OpenCode gives it. Claude Code leaves it out (decision 35). */
  provider?: string
}

/**
 * Why a check did not run: `pending` waits for more edits (`every`, `lines`), `unchanged` is a project that did not
 * change since its checks passed, and `build` passed on the reports of a build since the last change.
 */
export type SkipReason = "pending" | "unchanged" | "build"

export type MetricResult = "passed" | "violations" | "failed" | "missing-dir" | "broken-build" | "skipped"

/** One violation as the metrics keep it: its rule and file, never its line, message or code (decision 41). */
export interface ViolationMetric {
  rule: string
  type?: RuleType
  /** `/`-separated and relative to the directory of `interlint.yaml`, when the report gave it. */
  file?: string
}

/** What one check did in one run of `interlint check`, with who ran it. */
export interface CheckMetric extends AgentContext {
  when: When
  check: string
  report: Report
  result: MetricResult
  /** Present only when `result` is `skipped`. */
  skipped?: SkipReason
  /** 0 when the check did not run. */
  durationMs: number
  /** Present only when `result` is `violations`. */
  violations?: ViolationMetric[]
}
