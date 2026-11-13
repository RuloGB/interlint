import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../../application/checking/ports.js"
import { DEPCRUISE_REPORT } from "../../../domain/depcruise-command.js"
import type { RuleFailure, Violation } from "../../../domain/violation.js"

/** The severity of a violation the project does not accept. `warn`, `info` and `ignore` are accepted. */
const ERROR = "error"
/**
 * The issue dependency-cruiser gives when the project needs a TypeScript compiler it does not support, such as
 * TypeScript 7. It then leaves out the TypeScript sources, and exits 0 without their violations.
 */
const MISSING_TYPESCRIPT = "missing-typescript-transpiler"

/** What dependency-cruiser's report holds for the check. */
export interface DepcruiseReport {
  /** Whether it analyzed the sources: some module, and the TypeScript ones with a TypeScript compiler it supports. */
  cruised: boolean
  failures: RuleFailure[]
}

function reportPath(projectDir: string): string {
  return join(projectDir, ...DEPCRUISE_REPORT.split("/"))
}

/** Size as well as time, or nothing when the report is gone. Kept only for a report that could not be deleted. */
function fingerprint(path: string): string | undefined {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${mtimeMs}:${size}`
  } catch {
    return undefined
  }
}

/**
 * Deletes the report of an earlier run, so the one the run leaves is its own: a rewrite with the same size and a
 * coarse clock's same time cannot pass for the old one. Only a report that cannot be deleted is fingerprinted.
 *
 * Also creates the report's directory: with `--output-to` in a directory that does not exist, dependency-cruiser
 * fails without a report. Even without a `node_modules` of the project's own: in an npm workspace that hoists its
 * dependencies, npx runs the dependency-cruiser of the root's.
 */
function snapshotDepcruiseReport(projectDir: string): ReportSnapshot {
  const path = reportPath(projectDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    rmSync(path, { force: true })
  } catch {
    // The run shows why it could not write the report, and a report left in place is fingerprinted.
  }
  const left = fingerprint(path)
  return new Map(left === undefined ? [] : [[path, left]])
}

/** Reads the report when the run wrote or rewrote it and analyzed the sources. */
function readDepcruiseReport(projectDir: string, before: ReportSnapshot): ReportResult {
  const path = reportPath(projectDir)
  const now = fingerprint(path)
  if (now === undefined || before.get(path) === now) return { found: false, failures: [] }
  let json: string
  try {
    json = readFileSync(path, "utf8")
  } catch {
    return { found: false, failures: [] }
  }
  const { cruised, failures } = parseDepcruiseJson(json)
  return cruised ? { found: true, failures } : { found: false, failures: [] }
}

/**
 * With `-T json`, dependency-cruiser exits 0 whatever it finds, so its report decides: the violations of severity
 * `error` are the failures, and those the project accepts are never given.
 */
export const depcruiseReader: ReportReader = {
  snapshot: snapshotDepcruiseReport,
  read: readDepcruiseReport,
}

/**
 * The `error` violations of dependency-cruiser's JSON report grouped by rule, in the order they first appear. Each is
 * given at its source module, the file that holds the import. A report that is not dependency-cruiser's gives nothing.
 */
export function parseDepcruiseJson(json: string): DepcruiseReport {
  let report: unknown
  try {
    report = JSON.parse(json)
  } catch {
    return { cruised: false, failures: [] }
  }
  const summary = isRecord(report) ? report.summary : undefined
  if (!isRecord(summary) || !Array.isArray(summary.violations)) return { cruised: false, failures: [] }
  if (summary.totalCruised === 0 || missesTypescript(summary.environment)) return { cruised: false, failures: [] }
  const comments = commentsOf(summary.ruleSetUsed)
  const byRule = new Map<string, RuleFailure>()
  for (const entry of summary.violations) {
    if (!isRecord(entry) || !isRecord(entry.rule) || typeof entry.from !== "string") continue
    const { name, severity } = entry.rule
    if (typeof name !== "string" || severity !== ERROR) continue
    const violation = violationOf(entry.from, entry.to, entry.cycle)
    const failure = byRule.get(name)
    if (failure) failure.violations.push(violation)
    else {
      const comment = comments.get(name)
      byRule.set(name, { title: comment ? `${name}: ${comment}` : name, type: "architecture", violations: [violation] })
    }
  }
  return { cruised: true, failures: [...byRule.values()] }
}

function missesTypescript(environment: unknown): boolean {
  if (!isRecord(environment) || !Array.isArray(environment.issues)) return false
  return environment.issues.some((issue: unknown) => isRecord(issue) && issue.name === MISSING_TYPESCRIPT)
}

/** The comment the team wrote for each rule, which says why the dependency is forbidden. */
function commentsOf(ruleSet: unknown): Map<string, string> {
  const comments = new Map<string, string>()
  if (!isRecord(ruleSet) || !Array.isArray(ruleSet.forbidden)) return comments
  for (const rule of ruleSet.forbidden) {
    if (isRecord(rule) && typeof rule.name === "string" && typeof rule.comment === "string" && rule.comment.trim() !== "") {
      comments.set(rule.name, rule.comment.trim())
    }
  }
  return comments
}

function violationOf(from: string, to: unknown, cycle: unknown): Violation {
  const path = from.replaceAll("\\", "/")
  const file = path.split("/").at(-1) ?? path
  if (typeof to !== "string" || to === from) return { text: `Module ${path}`, file, path }
  const steps = Array.isArray(cycle)
    ? cycle.flatMap((step: unknown) => (isRecord(step) && typeof step.name === "string" ? [step.name] : []))
    : []
  const through = steps.length > 0 ? ` (cycle: ${[path, ...steps].join(" → ")})` : ""
  const related = [...new Set(steps)].filter((step) => step !== path)
  return { text: `${path} depends on ${to}${through}`, file, path, ...(related.length > 0 ? { related } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
