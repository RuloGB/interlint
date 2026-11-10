import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../../application/checking/ports.js"
import { ESLINT_REPORT } from "../../../domain/eslint-command.js"
import type { RuleFailure, Violation } from "../../../domain/violation.js"

/** ESLint's severity of an error. A warning is 1. */
const ERROR = 2
/** The warning ESLint gives for a file its configuration ignores or does not cover. It is never the agent's to fix. */
const FILE_IGNORED = /^File ignored\b/
/** The title of an error ESLint gives without a rule, such as a file it cannot parse. */
const NO_RULE = "ESLint"

interface Finding {
  rule: string
  error: boolean
  violation: Violation
}

function reportPath(projectDir: string): string {
  return join(projectDir, ...ESLINT_REPORT.split("/"))
}

/** Size as well as time: coarse filesystem clocks can give a rewritten report the same mtime. */
function fingerprint(path: string): string {
  const { mtimeMs, size } = statSync(path)
  return `${mtimeMs}:${size}`
}

function snapshotEslintReport(projectDir: string): ReportSnapshot {
  const path = reportPath(projectDir)
  return new Map(existsSync(path) ? [[path, fingerprint(path)]] : [])
}

/** Reads the report when the run wrote or rewrote it. ESLint writes none when it fails before checking any file. */
function readEslintReport(projectDir: string, before: ReportSnapshot): ReportResult {
  const path = reportPath(projectDir)
  if (!existsSync(path) || before.get(path) === fingerprint(path)) return { found: false, failures: [] }
  return { found: true, failures: parseEslintJson(readFileSync(path, "utf8"), projectDir) }
}

/**
 * The report lists the warnings the project accepts too, so its failures count only when ESLint fails
 * (decision 54). With errors, only they are given; without any, ESLint failed on its warnings (`--max-warnings`).
 */
export const eslintReader: ReportReader = {
  snapshot: snapshotEslintReport,
  read: readEslintReport,
  alsoListsAccepted: true,
}

/**
 * The errors of ESLint's JSON report grouped by rule, in the order they first appear, or its warnings when it has
 * no error. A report that is not ESLint's gives nothing, so the check shows the command's output instead.
 */
export function parseEslintJson(json: string, projectDir: string): RuleFailure[] {
  const findings = findingsIn(json, rootsOf(projectDir))
  const errors = findings.some((finding) => finding.error)
  const byRule = new Map<string, RuleFailure>()
  for (const { rule, error, violation } of findings) {
    if (error !== errors) continue
    const failure = byRule.get(rule)
    if (failure) failure.violations.push(violation)
    else byRule.set(rule, { title: rule, type: "eslint", violations: [violation] })
  }
  return [...byRule.values()]
}

function findingsIn(json: string, roots: string[]): Finding[] {
  let report: unknown
  try {
    report = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(report)) return []
  return report.flatMap((file: unknown) => {
    if (!isRecord(file) || typeof file.filePath !== "string" || !Array.isArray(file.messages)) return []
    const filePath = file.filePath
    return file.messages.flatMap((message: unknown): Finding[] => {
      if (!isRecord(message) || typeof message.message !== "string") return []
      const rule = typeof message.ruleId === "string" ? message.ruleId : undefined
      if (rule === undefined && FILE_IGNORED.test(message.message)) return []
      return [
        {
          rule: rule ?? NO_RULE,
          error: message.severity === ERROR,
          violation: violationAt(roots, filePath, message.line, message.message),
        },
      ]
    })
  })
}

/**
 * The project's directory as given and as the file system resolves it. ESLint names each file from its own working
 * directory, which is the resolved one when the project is reached through a link.
 */
function rootsOf(projectDir: string): string[] {
  try {
    return [...new Set([projectDir, realpathSync(projectDir)])]
  } catch {
    return [projectDir]
  }
}

function violationAt(roots: string[], filePath: string, line: unknown, text: string): Violation {
  const path = roots
    .map((root) => relative(root, filePath))
    .find((candidate) => candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate))
  return {
    text,
    file: basename(filePath),
    ...(typeof line === "number" && line > 0 ? { line } : {}),
    ...(path === undefined ? {} : { path: path.split(sep).join("/") }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
