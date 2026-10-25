import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../core/ports.js"
import type { RuleFailure, Violation } from "../../core/violation.js"

const CHECKSTYLE_REPORT = join("target", "checkstyle-result.xml")
const PMD_REPORT = join("target", "pmd.xml")
const REPORTS = [CHECKSTYLE_REPORT, PMD_REPORT]

/** The line Maven prints when a Checkstyle or PMD `check` goal fails, with or without -q. */
const FAILED_CHECK_GOAL = /Failed to execute goal [^:\s]+:maven-(checkstyle|pmd)-plugin:[^:\s]+:check\b/g

/** How many levels of Maven modules below the project are searched for reports. */
const MAX_MODULE_DEPTH = 3
const NOT_MODULES = new Set(["src", "target", "node_modules"])

/** Checkstyle severities, most severe first. `ignore` is never shown. */
const CHECKSTYLE_SEVERITIES = ["error", "warning", "info"]
/** PMD's least severe priority, used when a violation has none. */
const LOWEST_PMD_PRIORITY = 5

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "file" || name === "error" || name === "violation",
})

interface ReportFile {
  name?: string
  error?: Record<string, string>[]
  violation?: (Record<string, string> & { "#text"?: string })[]
}

/** A rule broken at one place, with how severe the tool rates it: the lower, the more severe. */
interface Finding {
  rule: string
  rank: number
  violation: Violation
}

/** Records the Checkstyle and PMD reports already in `target/`, so a later read can tell them apart from new ones. */
export function snapshotQualityReports(projectDir: string): ReportSnapshot {
  return new Map(reportFiles(projectDir).map((path) => [path, fingerprint(path)]))
}

/** Size as well as time, as for the Surefire reports: coarse filesystem clocks can give a rewritten report the same mtime. */
function fingerprint(path: string): string {
  const { mtimeMs, size } = statSync(path)
  return `${mtimeMs}:${size}`
}

/**
 * Reads the Checkstyle and PMD reports written or rewritten since `before`, in the project and its modules.
 * Reports left in `target/` by previous runs are ignored, and so are the reports of a plugin whose `check`
 * did not fail according to `output`: when Maven failed for another reason, such as a module that does not
 * compile, the reports only hold what the build accepted.
 */
export function readQualityReports(projectDir: string, before: ReportSnapshot, output: string): ReportResult {
  const reports = reportFiles(projectDir).filter((path) => before.get(path) !== fingerprint(path))
  const failed = new Set([...output.matchAll(FAILED_CHECK_GOAL)].map((match) => match[1]))
  const findingsOf = (report: string, parse: (xml: string, projectDir: string) => Finding[]) =>
    reports.filter((path) => path.endsWith(report)).flatMap((path) => readReport(path, projectDir, parse))
  return {
    found: reports.length > 0,
    failures: [
      ...(failed.has("checkstyle") ? mostSevere(findingsOf(CHECKSTYLE_REPORT, checkstyleFindings)) : []),
      ...(failed.has("pmd") ? mostSevere(findingsOf(PMD_REPORT, pmdFindings)) : []),
    ],
  }
}

/**
 * A report that is not well-formed XML gives no findings, so the check shows Maven's output instead.
 * Checkstyle leaves one cut short when it stops on a source it cannot parse.
 */
function readReport(path: string, projectDir: string, parse: (xml: string, projectDir: string) => Finding[]): Finding[] {
  try {
    return parse(readFileSync(path, "utf8"), projectDir)
  } catch {
    return []
  }
}

/**
 * The reports list what the build accepted too, such as warnings under `violationSeverity` or violations
 * under `failurePriority`, so their failures count only when Maven fails.
 */
export const mavenQualityReader: ReportReader = {
  snapshot: snapshotQualityReports,
  read: readQualityReports,
  alsoListsAccepted: true,
}

export function parseCheckstyleXml(xml: string, projectDir: string): RuleFailure[] {
  return mostSevere(checkstyleFindings(xml, projectDir))
}

export function parsePmdXml(xml: string, projectDir: string): RuleFailure[] {
  return mostSevere(pmdFindings(xml, projectDir))
}

function checkstyleFindings(xml: string, projectDir: string): Finding[] {
  const files: ReportFile[] = xmlParser.parse(xml)?.checkstyle?.file ?? []
  return files.flatMap((file) =>
    (file.error ?? [])
      .filter((error) => CHECKSTYLE_SEVERITIES.includes(error.severity ?? "error"))
      .map((error) => ({
        rule: checkstyleRule(error.source),
        rank: CHECKSTYLE_SEVERITIES.indexOf(error.severity ?? "error"),
        violation: violationAt(projectDir, file.name, error.line, error.message ?? ""),
      })),
  )
}

/** The rule as Checkstyle prints it on the console: `...checks.sizes.LineLengthCheck` is `LineLength`. */
function checkstyleRule(source: string | undefined): string {
  if (!source) return "Checkstyle"
  return (source.split(".").at(-1) ?? source).replace(/Check$/, "")
}

function pmdFindings(xml: string, projectDir: string): Finding[] {
  const files: ReportFile[] = xmlParser.parse(xml)?.pmd?.file ?? []
  return files.flatMap((file) =>
    (file.violation ?? []).map((violation) => ({
      rule: violation.rule ?? "PMD",
      rank: Number(violation.priority) || LOWEST_PMD_PRIORITY,
      violation: violationAt(projectDir, file.name, violation.beginline, (violation["#text"] ?? "").trim()),
    })),
  )
}

function violationAt(projectDir: string, name: string | undefined, line: string | undefined, text: string): Violation {
  if (!name) return { text }
  const lineNumber = Number(line)
  const path = relative(projectDir, name)
  const inside = path !== "" && !path.startsWith("..") && !isAbsolute(path)
  return {
    text,
    file: basename(name),
    ...(lineNumber > 0 ? { line: lineNumber } : {}),
    ...(inside ? { path: path.split(sep).join("/") } : {}),
  }
}

/**
 * The findings of the most severe level present, grouped by rule in the order they first appear.
 * When Maven failed, that level is always one that failed the build, so nothing the build accepted is shown.
 * Less severe failures, if any, show on the next run.
 * A loop rather than `Math.min(...ranks)`: a large codebase can have more findings than a call takes arguments.
 */
function mostSevere(findings: Finding[]): RuleFailure[] {
  let top = Number.POSITIVE_INFINITY
  for (const finding of findings) top = Math.min(top, finding.rank)
  const byRule = new Map<string, Violation[]>()
  for (const finding of findings) {
    if (finding.rank !== top) continue
    const violations = byRule.get(finding.rule)
    if (violations) violations.push(finding.violation)
    else byRule.set(finding.rule, [finding.violation])
  }
  return [...byRule].map(([title, violations]) => ({ title, violations }))
}

function reportFiles(projectDir: string): string[] {
  return moduleDirs(projectDir, 0)
    .flatMap((dir) => REPORTS.map((report) => join(dir, report)))
    .filter((path) => existsSync(path))
}

/** The project and the Maven modules below it: the directories with their own `pom.xml`. */
function moduleDirs(dir: string, depth: number): string[] {
  if (depth >= MAX_MODULE_DEPTH) return [dir]
  const modules = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NOT_MODULES.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .filter((child) => existsSync(join(child, "pom.xml")))
    .sort()
  return [dir, ...modules.flatMap((module) => moduleDirs(module, depth + 1))]
}
