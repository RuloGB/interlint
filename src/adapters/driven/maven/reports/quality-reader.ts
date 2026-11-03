import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../../../application/checking/ports.js"
import type { RuleFailure, Violation } from "../../../../domain/violation.js"
import { moduleDirs } from "../modules.js"

const CHECKSTYLE_REPORT = join("target", "checkstyle-result.xml")
const PMD_REPORT = join("target", "pmd.xml")
const REPORTS = [CHECKSTYLE_REPORT, PMD_REPORT]
/** How each report ends when it was written whole. Checkstyle leaves one cut short when it stops on a source. */
const COMPLETE_REPORTS = [
  { report: CHECKSTYLE_REPORT, end: /<\/checkstyle>\s*$/ },
  { report: PMD_REPORT, end: /<\/pmd>\s*$/ },
]

/** The line Maven prints when a Checkstyle or PMD `check` goal fails, with or without -q. */
const FAILED_CHECK_GOAL = /Failed to execute goal [^:\s]+:maven-(checkstyle|pmd)-plugin:[^:\s]+:check\b/g
/** A Checkstyle or PMD `check` goal, plain or naming an execution (`checkstyle:check@style`), as a word of a command. */
const CHECK_GOAL = /(?:^|\s)(checkstyle|pmd):check(?:@\S+)?(?=\s|$)/g

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
  return { found: reports.length > 0, failures: failuresIn(reports, projectDir, failed) }
}

/**
 * Reads the reports of the `check` goals `command` runs, when each goal left at least one and every one of them was
 * written after `sinceMs` and whole, as a build the agent ran after its last change leaves them. With no
 * exit code to tell what the build accepted, every finding is a failure.
 */
export function readFreshQualityReports(projectDir: string, command: string, sinceMs: number): ReportResult | undefined {
  const plugins = new Set([...command.matchAll(CHECK_GOAL)].map((match) => match[1]))
  if (plugins.size === 0) return undefined
  const wanted = [...plugins].map((plugin) => (plugin === "checkstyle" ? CHECKSTYLE_REPORT : PMD_REPORT))
  const reports = reportFiles(projectDir).filter((path) => wanted.some((report) => path.endsWith(report)))
  if (!wanted.every((report) => reports.some((path) => path.endsWith(report)))) return undefined
  if (!reports.every((path) => statSync(path).mtimeMs > sinceMs && isComplete(path))) {
    return undefined
  }
  return { found: true, failures: failuresIn(reports, projectDir, plugins) }
}

/** Whether the Checkstyle or PMD report ends as one written whole does. */
function isComplete(path: string): boolean {
  const xml = readFileSync(path, "utf8")
  return COMPLETE_REPORTS.some(({ report, end }) => path.endsWith(report) && end.test(xml))
}

/** The most severe findings of the reports, for each plugin in `plugins`. */
function failuresIn(reports: string[], projectDir: string, plugins: Set<string | undefined>): RuleFailure[] {
  const findingsOf = (report: string, parse: (xml: string, projectDir: string) => Finding[]) =>
    reports.filter((path) => path.endsWith(report)).flatMap((path) => readReport(path, projectDir, parse))
  return [
    ...(plugins.has("checkstyle") ? mostSevere(findingsOf(CHECKSTYLE_REPORT, checkstyleFindings)) : []),
    ...(plugins.has("pmd") ? mostSevere(findingsOf(PMD_REPORT, pmdFindings)) : []),
  ]
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
  readFresh: readFreshQualityReports,
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
  return moduleDirs(projectDir)
    .flatMap((dir) => REPORTS.map((report) => join(dir, report)))
    .filter((path) => existsSync(path))
}
