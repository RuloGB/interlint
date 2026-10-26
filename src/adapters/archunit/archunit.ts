import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ReportReader, ReportResult, ReportSnapshot } from "../../core/ports.js"
import type { RuleFailure, Violation } from "../../core/violation.js"
import { moduleDirs } from "../maven/modules.js"

const REPORTS_DIR = join("target", "surefire-reports")
const SOURCE_ROOTS = ["src/main/java", "src/test/java"]

const HEADER = /^Architecture Violation \[Priority: \w+\] - Rule '(.*)' was violated \(\d+ times?\):$/
const BECAUSE = ", because "
const RULE_ID = /^\[?[A-Z][A-Z0-9]*-\d+\]?/
const LOCATION = /\(([\w$]+\.java):(\d+)\)\s*$/
const FIRST_CODE_UNIT = /<([\w$.]+)/
/** The parameter types of a method or constructor, as in `<com.acme.Order.<init>(java.lang.String, int)>`. */
const SIGNATURE = /<[\w$.]+?(?:\.<(?:init|clinit)>)?\(([^()]*)\)>/g
/** The type of a field, parameter or return value. A generic type can name a type variable, such as `<T>`, so it is left out. */
const TYPE = /(?<!generic )(?:of type|return type|has type) <([^<>]+)>/g
const SIMPLE_NAME = /^[A-Za-z_$][\w$]*$/
const PRIMITIVES = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"])

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

/** Records the Surefire reports already in the `target/` of the project and its modules, so a later read can tell them apart from new ones. */
export function snapshotReports(projectDir: string): ReportSnapshot {
  return new Map(reportFiles(moduleDirs(projectDir)).map((path) => [path, fingerprint(path)]))
}

/** Size as well as time: coarse filesystem clocks can give a rewritten report the same mtime. */
function fingerprint(path: string): string {
  const { mtimeMs, size } = statSync(path)
  return `${mtimeMs}:${size}`
}

/**
 * Reads the Surefire XML reports written or rewritten since `before`, in the project and its modules, and returns
 * their ArchUnit failures. Reports left in `target/` by previous runs are ignored.
 */
export function readArchUnitReport(projectDir: string, before: ReportSnapshot): ReportResult {
  const modules = moduleDirs(projectDir)
  const reports = reportFiles(modules).filter((path) => before.get(path) !== fingerprint(path))
  const failures = reports.flatMap((path) => parseSurefireXml(readFileSync(path, "utf8")))
  for (const failure of failures) {
    for (const violation of failure.violations) resolvePath(projectDir, modules, violation)
  }
  const typesWithoutPackage = typesWithoutPackageIn(failures)
  return { found: reports.length > 0, failures, ...(typesWithoutPackage.length > 0 ? { typesWithoutPackage } : {}) }
}

/**
 * The types the violations name without a package, in order of appearance. ArchUnit names every type in full, so
 * a bare name comes from a class file that names it that way: one that Eclipse's compiler, as IDEs run it, writes
 * when it cannot resolve a type. A class in the default package would show the same, but rules rarely analyze it.
 */
function typesWithoutPackageIn(failures: RuleFailure[]): string[] {
  const types = failures.flatMap(({ violations }) =>
    violations.flatMap(({ text }) => [
      ...[...text.matchAll(SIGNATURE)].flatMap((match) => match[1]!.split(",")),
      ...[...text.matchAll(TYPE)].map((match) => match[1]!),
    ]),
  )
  return [...new Set(types.map((type) => type.trim().replace(/(?:\[\])+$/, "")))].filter(
    (type) => SIMPLE_NAME.test(type) && !PRIMITIVES.has(type),
  )
}

export const archUnitReader: ReportReader = { snapshot: snapshotReports, read: readArchUnitReport }

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

/** The violation's source, in the first module that has it, as a `/`-separated path relative to the project. */
function resolvePath(projectDir: string, modules: string[], violation: Violation) {
  if (!violation.className || !violation.file) return
  const packagePath = violation.className.split(".").slice(0, -1).join("/")
  for (const module of modules) {
    for (const root of SOURCE_ROOTS) {
      const candidate = join(module, root, packagePath, violation.file)
      if (existsSync(candidate)) {
        violation.path = relative(projectDir, candidate).split(sep).join("/")
        return
      }
    }
  }
}

function reportFiles(modules: string[]): string[] {
  return modules.flatMap((module) => {
    const dir = join(module, REPORTS_DIR)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.startsWith("TEST-") && name.endsWith(".xml"))
      .map((name) => join(dir, name))
      .sort()
  })
}
