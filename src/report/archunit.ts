import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportResult, RuleFailure, Violation } from "./report.js"

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

/**
 * Reads the Surefire XML reports written since `startedAt` and returns their ArchUnit failures.
 * Older reports left in `target/` by previous runs are ignored.
 */
export function readArchUnitReport(projectDir: string, startedAt: number): ReportResult {
  const reports = freshReports(join(projectDir, REPORTS_DIR), startedAt)
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

function freshReports(dir: string, startedAt: number): string[] {
  if (!existsSync(dir)) return []
  // Whole seconds: some filesystems store modification times with one-second precision.
  const since = Math.floor(startedAt / 1000) * 1000
  return readdirSync(dir)
    .filter((name) => name.startsWith("TEST-") && name.endsWith(".xml"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= since)
    .sort()
}
