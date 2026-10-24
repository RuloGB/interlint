import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportResult, ReportSnapshot, RuleFailure, Violation } from "./report.js"

const REPORTS_DIR = join("target", "surefire-reports")
const SOURCE_ROOTS = ["src/main/java", "src/test/java"]

const HEADER = /^Architecture Violation \[Priority: \w+\] - Rule '(.*)' was violated \(\d+ times?\):$/
const BECAUSE = ", because "
const RULE_ID = /^\[?[A-Z][A-Z0-9]*-\d+\]?/
const LOCATION = /\(([\w$]+\.java):(\d+)\)\s*$/
const FIRST_CODE_UNIT = /<([\w$.]+)/

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  htmlEntities: true,
  isArray: (name) => name === "testcase" || name === "failure" || name === "error",
})

interface SurefireTestcase {
  name?: string
  failure?: SurefireProblem[]
  error?: SurefireProblem[]
}

interface SurefireProblem {
  message?: string
}

/** Records the Surefire reports already in `target/`, so a later read can tell them apart from new ones. */
export function snapshotReports(projectDir: string): ReportSnapshot {
  return new Map(reportFiles(projectDir).map((path) => [path, statSync(path).mtimeMs]))
}

/**
 * Reads the Surefire XML reports written or rewritten since `before` and returns their ArchUnit failures.
 * Reports left in `target/` by previous runs are ignored.
 */
export function readArchUnitReport(projectDir: string, before: ReportSnapshot): ReportResult {
  const reports = reportFiles(projectDir).filter((path) => before.get(path) !== statSync(path).mtimeMs)
  const failures = reports.flatMap((path) => parseSurefireXml(readFileSync(path, "utf8")))
  for (const failure of failures) {
    for (const violation of failure.violations) resolvePath(projectDir, violation)
  }
  return { found: reports.length > 0, failures }
}

export function parseSurefireXml(xml: string): RuleFailure[] {
  const document = xmlParser.parse(xml)
  const testcases: SurefireTestcase[] = document?.testsuite?.testcase ?? []
  return testcases.flatMap((testcase) =>
    [...(testcase.failure ?? []), ...(testcase.error ?? [])].map((problem) =>
      toRuleFailure(testcase.name ?? "unnamed test", problem.message ?? ""),
    ),
  )
}

function toRuleFailure(testName: string, message: string): RuleFailure {
  const [firstLine = "", ...rest] = message.split(/\r?\n/)
  const header = HEADER.exec(firstLine)
  if (!header) return { title: `${testName}: ${firstLine}`, violations: [] }

  const rule = header[1] ?? ""
  const becauseAt = rule.lastIndexOf(BECAUSE)
  const reason = becauseAt >= 0 ? rule.slice(becauseAt + BECAUSE.length) : undefined
  const title = reason !== undefined && RULE_ID.test(reason) ? reason : `${testName}: ${reason ?? rule}`

  return {
    title,
    violations: rest.filter((line) => line.trim() !== "").map(toViolation),
  }
}

function toViolation(text: string): Violation {
  const location = LOCATION.exec(text)
  if (!location) return { text }

  const file = location[1] ?? ""
  const line = Number(location[2])
  const className = classNameOf(text, file)
  return {
    text,
    ...(className ? { className } : {}),
    file,
    ...(line > 0 ? { line } : {}),
  }
}

/** The class that owns the violation: the first code unit, cut at the segment that names its file. */
function classNameOf(text: string, file: string): string | undefined {
  const codeUnit = FIRST_CODE_UNIT.exec(text)?.[1]
  if (!codeUnit) return undefined
  const base = file.replace(/\.java$/, "")
  const segments = codeUnit.split(".")
  const classAt = segments.findLastIndex((segment) => segment === base || segment.startsWith(`${base}$`))
  return classAt >= 0 ? segments.slice(0, classAt + 1).join(".") : undefined
}

function resolvePath(projectDir: string, violation: Violation) {
  if (!violation.className || !violation.file) return
  const packagePath = violation.className.split(".").slice(0, -1).join("/")
  for (const root of SOURCE_ROOTS) {
    const candidate = `${root}/${packagePath}/${violation.file}`
    if (existsSync(join(projectDir, candidate))) {
      violation.path = candidate
      return
    }
  }
}

function reportFiles(projectDir: string): string[] {
  const dir = join(projectDir, REPORTS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith("TEST-") && name.endsWith(".xml"))
    .map((name) => join(dir, name))
    .sort()
}
