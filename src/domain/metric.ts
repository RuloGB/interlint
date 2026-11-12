import { REPORTS, type Report, type When, WHENS } from "./check.js"
import type { RuleType } from "./violation.js"

/**
 * Who ran the checks, as the agent integrations tell it. Every field is absent when the checks ran by hand, or when
 * the agent does not give it (decision 36).
 */
export interface AgentContext {
  /** `claude-code`, `copilot` or `opencode`. */
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

/** The version of the metrics line format. A reader of older lines tells them apart by it. */
export const METRICS_FORMAT_VERSION = 1

/** One line of the metrics files: a check's metric with when, where and by which Interlint it was kept. */
export interface MetricEvent extends CheckMetric {
  v: number
  /** ISO 8601 in UTC. Every line of one run of `interlint check` has the same. */
  at: string
  interlint: string
  projectKey: string
  /** The project's folder name, never its path (decision 40). */
  project: string
}

const RESULTS: readonly MetricResult[] = ["passed", "violations", "failed", "missing-dir", "broken-build", "skipped"]
const SKIP_REASONS: readonly SkipReason[] = ["pending", "unchanged", "build"]
const RULE_TYPES: readonly RuleType[] = ["architecture", "checkstyle", "pmd", "coverage", "eslint"]
const AGENT_FIELDS = ["agent", "session", "agentType", "model", "provider"] as const

/**
 * The event a parsed metrics line holds, or `undefined` when it is not one, such as a line edited by hand or written
 * by a format this version does not know. Fields it does not know are left out.
 */
export function metricEventOf(value: unknown): MetricEvent | undefined {
  if (!isRecord(value)) return undefined
  const { v, at, interlint, projectKey, project, when, check, report, result, skipped, durationMs } = value
  if (v !== METRICS_FORMAT_VERSION) return undefined
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined
  if (!isText(interlint) || !isText(projectKey) || !isText(project) || !isText(check)) return undefined
  if (!isOneOf(when, WHENS) || !isOneOf(report, REPORTS) || !isOneOf(result, RESULTS)) return undefined
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined
  // In UTC as Interlint writes it, so a date edited by hand sorts and filters with the rest.
  const event: MetricEvent = { v, at: new Date(at).toISOString(), interlint, projectKey, project, when, check, report, result, durationMs }
  if (skipped !== undefined) {
    if (!isOneOf(skipped, SKIP_REASONS)) return undefined
    event.skipped = skipped
  }
  if (value.violations !== undefined) {
    const violations = violationsOf(value.violations)
    if (violations === undefined) return undefined
    event.violations = violations
  }
  for (const field of AGENT_FIELDS) {
    const given = value[field]
    if (given === undefined) continue
    if (!isText(given)) return undefined
    event[field] = given
  }
  if (value.subagent === true) event.subagent = true
  return event
}

function violationsOf(value: unknown): ViolationMetric[] | undefined {
  if (!Array.isArray(value)) return undefined
  const violations: ViolationMetric[] = []
  for (const item of value) {
    if (!isRecord(item) || !isText(item.rule)) return undefined
    const violation: ViolationMetric = { rule: item.rule }
    if (item.type !== undefined) {
      if (!isOneOf(item.type, RULE_TYPES)) return undefined
      violation.type = item.type
    }
    if (item.file !== undefined) {
      if (!isText(item.file)) return undefined
      violation.file = item.file
    }
    violations.push(violation)
  }
  return violations
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}
