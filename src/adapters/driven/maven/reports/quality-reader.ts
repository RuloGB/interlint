import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../../../application/checking/ports.js"
import type { RuleFailure, RuleType, Violation } from "../../../../domain/violation.js"
import { moduleDirs } from "../modules.js"

const CHECKSTYLE_REPORT = join("target", "checkstyle-result.xml")
const PMD_REPORT = join("target", "pmd.xml")
const SPOTBUGS_REPORT = join("target", "spotbugsXml.xml")
/** Each plugin's report, by the plugin's name in its goals. */
const PLUGIN_REPORTS: Record<string, string> = {
  checkstyle: CHECKSTYLE_REPORT,
  pmd: PMD_REPORT,
  spotbugs: SPOTBUGS_REPORT,
}
const REPORTS = Object.values(PLUGIN_REPORTS)
const SPOTBUGS_END = /<\/BugCollection>\s*$/
/** How each report ends when it was written whole. Checkstyle leaves one cut short when it stops on a source. */
const COMPLETE_REPORTS = [
  { report: CHECKSTYLE_REPORT, end: /<\/checkstyle>\s*$/ },
  { report: PMD_REPORT, end: /<\/pmd>\s*$/ },
  { report: SPOTBUGS_REPORT, end: SPOTBUGS_END },
]

/**
 * The line Maven prints when a Checkstyle, PMD or SpotBugs `check` goal fails, with or without -q. SpotBugs' plugin
 * is `spotbugs-maven-plugin`, not `maven-spotbugs-plugin`.
 */
const FAILED_CHECK_GOAL =
  /Failed to execute goal [^:\s]+:(?:maven-(checkstyle|pmd)-plugin|(spotbugs)-maven-plugin):[^:\s]+:check\b/g
/** A Checkstyle, PMD or SpotBugs `check` goal, plain or naming an execution (`checkstyle:check@style`), as a word of a command. */
const CHECK_GOAL = /(?:^|\s)(checkstyle|pmd|spotbugs):check(?:@\S+)?(?=\s|$)/g

/** Checkstyle severities, most severe first. `ignore` is never shown. */
const CHECKSTYLE_SEVERITIES = ["error", "warning", "info"]
/** PMD's least severe priority, used when a violation has none. */
const LOWEST_PMD_PRIORITY = 5
/** SpotBugs' least severe priority, experimental, used when a bug has none. */
const LOWEST_SPOTBUGS_PRIORITY = 5

/** The elements a report can repeat, read as lists even when there is only one. */
const ARRAY_ELEMENTS = new Set(["file", "error", "violation", "BugInstance", "SrcDir", "SourceLine", "Field", "Method", "Class"])

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ARRAY_ELEMENTS.has(name),
})

interface ReportFile {
  name?: string
  error?: Record<string, string>[]
  violation?: (Record<string, string> & { "#text"?: string })[]
}

/** An element of a bug that SpotBugs places with source lines: the bug itself, or its field, method or class. */
interface Located {
  primary?: string
  SourceLine?: Record<string, string>[]
}

interface BugInstance extends Located {
  type?: string
  priority?: string
  LongMessage?: string
  Field?: Located[]
  Method?: Located[]
  Class?: Located[]
}

/** Maven's default source dir, relative to the module. */
const DEFAULT_SOURCES = join("src", "main", "java")

/** A rule broken at one place, with how severe the tool rates it: the lower, the more severe. */
interface Finding {
  rule: string
  type: RuleType
  rank: number
  violation: Violation
}

/** Records the Checkstyle, PMD and SpotBugs reports already in `target/`, so a later read can tell them apart from new ones. */
export function snapshotQualityReports(projectDir: string): ReportSnapshot {
  return new Map(reportFiles(projectDir).map((path) => [path, fingerprint(path)]))
}

/** Size as well as time, as for the Surefire reports: coarse filesystem clocks can give a rewritten report the same mtime. */
function fingerprint(path: string): string {
  const { mtimeMs, size } = statSync(path)
  return `${mtimeMs}:${size}`
}

/**
 * Reads the Checkstyle, PMD and SpotBugs reports written or rewritten since `before`, in the project and its modules.
 * Reports left in `target/` by previous runs are ignored, and so are the reports of a plugin whose `check`
 * did not fail according to `output`: when Maven failed for another reason, such as a module that does not
 * compile, the reports only hold what the build accepted.
 */
export function readQualityReports(projectDir: string, before: ReportSnapshot, output: string): ReportResult {
  const reports = reportFiles(projectDir).filter((path) => before.get(path) !== fingerprint(path))
  const failed = new Set([...output.matchAll(FAILED_CHECK_GOAL)].map((match) => match[1] ?? match[2]))
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
  const wanted = [...plugins].flatMap((plugin) => PLUGIN_REPORTS[plugin ?? ""] ?? [])
  const reports = reportFiles(projectDir).filter((path) => wanted.some((report) => path.endsWith(report)))
  if (!wanted.every((report) => reports.some((path) => path.endsWith(report)))) return undefined
  if (!reports.every((path) => statSync(path).mtimeMs > sinceMs && isComplete(path))) {
    return undefined
  }
  return { found: true, failures: failuresIn(reports, projectDir, plugins) }
}

/** Whether the Checkstyle, PMD or SpotBugs report ends as one written whole does. */
function isComplete(path: string): boolean {
  const xml = readFileSync(path, "utf8")
  return COMPLETE_REPORTS.some(({ report, end }) => path.endsWith(report) && end.test(xml))
}

/** Reads the findings of one report, with paths relative to `projectDir`; `moduleDir` is the module that wrote it. */
type ParseReport = (xml: string, projectDir: string, moduleDir: string) => Finding[]

/** The most severe findings of the reports, for each plugin in `plugins`. */
function failuresIn(reports: string[], projectDir: string, plugins: Set<string | undefined>): RuleFailure[] {
  const findingsOf = (report: string, parse: ParseReport) =>
    reports.filter((path) => path.endsWith(report)).flatMap((path) => readReport(path, projectDir, parse))
  return [
    ...(plugins.has("checkstyle") ? mostSevere(findingsOf(CHECKSTYLE_REPORT, checkstyleFindings)) : []),
    ...(plugins.has("pmd") ? mostSevere(findingsOf(PMD_REPORT, pmdFindings)) : []),
    ...(plugins.has("spotbugs") ? mostSevere(findingsOf(SPOTBUGS_REPORT, spotbugsFindings)) : []),
  ]
}

/**
 * A report that is not well-formed XML gives no findings, so the check shows Maven's output instead.
 * Checkstyle leaves one cut short when it stops on a source it cannot parse.
 */
function readReport(path: string, projectDir: string, parse: ParseReport): Finding[] {
  try {
    // Every report is in its module's `target/`.
    return parse(readFileSync(path, "utf8"), projectDir, dirname(dirname(path)))
  } catch {
    return []
  }
}

/**
 * The reports list what the build accepted too, such as warnings under `violationSeverity`, violations
 * under `failurePriority` or bugs under `failThreshold`, so their failures count only when Maven fails.
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

export function parseSpotBugsXml(xml: string, projectDir: string): RuleFailure[] {
  return mostSevere(spotbugsFindings(xml, projectDir))
}

function checkstyleFindings(xml: string, projectDir: string): Finding[] {
  const files: ReportFile[] = xmlParser.parse(xml)?.checkstyle?.file ?? []
  return files.flatMap((file) =>
    (file.error ?? [])
      .filter((error) => CHECKSTYLE_SEVERITIES.includes(error.severity ?? "error"))
      .map((error) => ({
        rule: checkstyleRule(error.source),
        type: "checkstyle" as const,
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
      type: "pmd" as const,
      rank: Number(violation.priority) || LOWEST_PMD_PRIORITY,
      violation: violationAt(projectDir, file.name, violation.beginline, (violation["#text"] ?? "").trim()),
    })),
  )
}

/**
 * Where a bug is, as the first source line with a line number among, in order: the bug's own lines (its primary one
 * first), then the lines of its primary field, method and class, then those of the others. Bugs about a class's design
 * or serialization have no line of their own, and SpotBugs writes some lines, such as a field annotation's, without a
 * number. When no line has a number, the first one still gives the file.
 */
function sourceLineOf(bug: BugInstance): Record<string, string> | undefined {
  const own = [...(bug.SourceLine ?? [])].sort((a, b) => Number(b.primary === "true") - Number(a.primary === "true"))
  const members = [bug.Field, bug.Method, bug.Class].map((elements) => elements ?? [])
  const linesOf = (primary: boolean) =>
    members.flatMap((elements) =>
      elements.filter((element) => (element.primary === "true") === primary).flatMap((element) => element.SourceLine ?? []),
    )
  const lines = [...own, ...linesOf(true), ...linesOf(false)]
  return lines.find((line) => Number(line.start) > 0) ?? lines[0]
}

/**
 * SpotBugs reads bytecode and names each source by its path below a source dir (`shop/Order.java`), so the source is
 * the first of the report's source dirs that holds it, or below the first one when none does. A report that lists
 * none is taken to use the module's `src/main/java` when the source is there; elsewhere, as with Kotlin or a custom
 * `sourceDirectory`, the bug has no path rather than one to a file that does not exist.
 * A report cut short throws, as one that is not well-formed: the parser would read the bugs before the cut.
 */
function spotbugsFindings(xml: string, projectDir: string, moduleDir = projectDir): Finding[] {
  if (!SPOTBUGS_END.test(xml)) throw new Error("SpotBugs report cut short")
  const collection = xmlParser.parse(xml)?.BugCollection
  const listed: string[] = (collection?.Project?.SrcDir ?? []).map(String)
  const srcDirs = listed.length > 0 ? listed : [join(moduleDir, DEFAULT_SOURCES)]
  const bugs: BugInstance[] = collection?.BugInstance ?? []
  return bugs.map((bug) => {
    const text = (bug.LongMessage ?? "").trim()
    const at = sourceLineOf(bug)
    const sourcepath = at?.sourcepath
    const candidates = sourcepath ? srcDirs.map((dir) => join(dir, sourcepath)) : []
    const source = candidates.find((path) => existsSync(path)) ?? (listed.length > 0 ? candidates[0] : undefined)
    const line = Number(at?.start)
    return {
      rule: bug.type ?? "SpotBugs",
      type: "spotbugs" as const,
      rank: Number(bug.priority) || LOWEST_SPOTBUGS_PRIORITY,
      violation:
        source || !at?.sourcefile
          ? violationAt(projectDir, source, at?.start, text)
          : { text, file: at.sourcefile, ...(line > 0 ? { line } : {}) },
    }
  })
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
  const byRule = new Map<string, RuleFailure>()
  for (const finding of findings) {
    if (finding.rank !== top) continue
    const failure = byRule.get(finding.rule)
    if (failure) failure.violations.push(finding.violation)
    else byRule.set(finding.rule, { title: finding.rule, type: finding.type, violations: [finding.violation] })
  }
  return [...byRule.values()]
}

function reportFiles(projectDir: string): string[] {
  return moduleDirs(projectDir)
    .flatMap((dir) => REPORTS.map((report) => join(dir, report)))
    .filter((path) => existsSync(path))
}
