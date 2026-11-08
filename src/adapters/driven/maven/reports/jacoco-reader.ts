import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { ReportReader, ReportResult } from "../../../../application/checking/ports.js"
import type { RuleFailure, Violation } from "../../../../domain/violation.js"
import { moduleDirs } from "../modules.js"

/**
 * A rule `jacoco:check` found broken, as it prints it: `Rule violated for bundle core: lines covered ratio is 0.50,
 * but expected minimum is 0.80`. Maven puts the level before it, and mvnd the module too, as in `[core] [WARNING]`.
 */
const BROKEN_RULE =
  /Rule violated for (?<element>\w+) (?<name>\S+): (?<counter>.+?) is (?<actual>\S+), but expected (?<bound>minimum|maximum) is (?<limit>\S+?)\s*$/
/** The line Maven prints when `jacoco:check` fails the build, with or without -q. */
const JACOCO_FAILED = /Failed to execute goal org\.jacoco:jacoco-maven-plugin:[^:\s]+:check\b.*? on project (\S+?):/
/** Any goal that failed, to tell a build that also failed for another reason. */
const FAILED_GOAL = /Failed to execute goal (\S+)/
const JACOCO_CHECK_GOAL = /^org\.jacoco:jacoco-maven-plugin:[^:\s]+:check$/
const ALL_MET = "All coverage checks have been met."
/** Colors a terminal-aware Maven may add to its output. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g
/** A `jacoco:check` goal of a command, plain or naming an execution, as a word of it. */
const CHECK_GOAL = /(?:^|\s)jacoco:check(?:@\S+)?(?=\s|$)/
/** The phases of Maven's default and clean lifecycles, which a recheck leaves out so no test runs. */
const LIFECYCLE_PHASES = new Set(
  [
    "pre-clean clean post-clean validate initialize generate-sources process-sources generate-resources",
    "process-resources compile process-classes generate-test-sources process-test-sources generate-test-resources",
    "process-test-resources test-compile process-test-classes test prepare-package package pre-integration-test",
    "integration-test post-integration-test verify install deploy",
  ]
    .join(" ")
    .split(" "),
)
/** Where a module keeps its tests: one with them and without coverage data was not tested. */
const TEST_SOURCES = join("src", "test", "java")
/** Where `prepare-agent` writes a module's coverage data by default. */
const EXEC_FILE = join("target", "jacoco.exec")
/** Where Surefire writes a module's test results, one `TEST-*.xml` per test class. */
const SUREFIRE_REPORTS = join("target", "surefire-reports")
/** The attributes of a test class's results that count its failed tests. */
const FAILED_COUNTS = /\b(?:failures|errors)="(\d+)"/g
/** Where Maven keeps a module's main sources, where a class rule's class is looked for. */
const MAIN_SOURCES = join("src", "main", "java")

/**
 * Reads the coverage rules `jacoco:check` found broken from the output of Maven: JaCoCo writes them nowhere else.
 * They count only when JaCoCo failed the build: with `haltOnFailure` false the build accepts them. A rule appears once
 * even when the build checked it twice. A build that also failed for another reason, such as a
 * failing test or a module that does not compile, gives no failures, so its output explains it. Found is false when
 * JaCoCo checked no rule, as with `-Djacoco.skip` or without execution data.
 */
export function readJacocoOutput(projectDir: string, output: string): ReportResult {
  const lines = output.replace(ANSI_ESCAPE, "").split(/\r?\n/)
  const failedGoals = lines.flatMap((line) => FAILED_GOAL.exec(line)?.[1] ?? [])
  const failedProjects = lines.flatMap((line) => JACOCO_FAILED.exec(line)?.[1] ?? [])
  const broken = [...new Set(lines.flatMap((line) => BROKEN_RULE.exec(line)?.[0].trimEnd() ?? []))]
  const found = broken.length > 0 || failedProjects.length > 0 || lines.some((line) => line.includes(ALL_MET))
  if (failedGoals.some((goal) => !JACOCO_CHECK_GOAL.test(goal))) return { found, failures: [], otherFailure: true }
  if (failedProjects.length === 0) return { found, failures: [] }
  if (broken.length === 0) return { found, failures: [hiddenRules(failedProjects)] }
  // Searched once, and only for a rule on a class: the tree of a large project takes a while to walk.
  let dirs: string[] | undefined
  const modules = () => (dirs ??= moduleDirs(projectDir))
  return { found, failures: byRule(broken.map((text) => brokenRule(projectDir, modules, text))) }
}

/** The rules of the projects whose coverage checks failed without printing which, as Maven does with -q. */
function hiddenRules(projects: string[]): RuleFailure {
  return {
    title: "Coverage checks have not been met",
    type: "coverage",
    violations: [...new Set(projects)].map((project) => ({
      text: `JaCoCo printed no broken rule of ${project}: run the check without -q to see them.`,
    })),
  }
}

interface BrokenRule {
  title: string
  violation: Violation
}

/** One broken rule, titled by what it limits, such as `lines covered ratio of each bundle: minimum 0.80`. */
function brokenRule(projectDir: string, modules: () => string[], text: string): BrokenRule {
  const { element = "", name = "", counter = "", bound = "", limit = "" } = BROKEN_RULE.exec(text)?.groups ?? {}
  return {
    title: `${counter} of each ${element}: ${bound} ${limit}`,
    violation: element === "class" ? { text, className: name, ...sourceOf(projectDir, modules(), name) } : { text },
  }
}

function byRule(rules: BrokenRule[]): RuleFailure[] {
  const failures = new Map<string, RuleFailure>()
  for (const { title, violation } of rules) {
    const failure = failures.get(title)
    if (failure) failure.violations.push(violation)
    else failures.set(title, { title, type: "coverage", violations: [violation] })
  }
  return [...failures.values()]
}

/**
 * The source file of a class JaCoCo names, such as `demo.Calc`, in the project or one of its modules. A nested
 * class, as in `demo.Calc.Part`, is in the file of its top-level class. Nothing when it is not found.
 */
function sourceOf(projectDir: string, modules: string[], className: string): Pick<Violation, "file" | "path"> {
  const parts = className.split(".")
  for (let length = parts.length; length > 0; length--) {
    const file = join(...parts.slice(0, length)) + ".java"
    for (const dir of modules) {
      const source = join(dir, MAIN_SOURCES, file)
      if (existsSync(source)) {
        return { file: `${parts[length - 1]}.java`, path: relative(projectDir, source).split(sep).join("/") }
      }
    }
  }
  return {}
}

/**
 * The command without its lifecycle phases, so its `jacoco:check` goals check the coverage data a build already left
 * instead of running the tests. Its other arguments stay, so its profiles and properties still apply. Given when every
 * module with tests has data, written after `sinceMs`, and all its tests ran since and passed. A module whose tests
 * did not run since, as with `-DskipTests`, keeps older data or none. A failing test still writes the data, and the
 * full check shows Maven's output for it. Then there is nothing to recheck.
 */
export function jacocoRecheck(projectDir: string, command: string, sinceMs: number): string | undefined {
  if (!CHECK_GOAL.test(command)) return undefined
  const modules = moduleDirs(projectDir)
  const withTests = modules.filter((dir) => existsSync(join(dir, TEST_SOURCES)))
  if (!withTests.every((dir) => existsSync(join(dir, EXEC_FILE)))) return undefined
  const execs = modules.map((dir) => join(dir, EXEC_FILE)).filter((path) => existsSync(path))
  if (execs.length === 0 || !execs.every((path) => statSync(path).mtimeMs > sinceMs)) return undefined
  if (!execs.every((path) => testsPassedSince(dirname(dirname(path)), sinceMs))) return undefined
  return command
    .trim()
    .split(/\s+/)
    .filter((word) => !LIFECYCLE_PHASES.has(word))
    .join(" ")
}

/**
 * Whether the module's Surefire reports show every test class ran after `sinceMs` with no failed test. One older than
 * that is a test the build did not run, so its coverage data misses that test. No report at all proves nothing.
 */
function testsPassedSince(moduleDir: string, sinceMs: number): boolean {
  const dir = join(moduleDir, SUREFIRE_REPORTS)
  let reports: string[]
  try {
    reports = readdirSync(dir).filter((name) => name.startsWith("TEST-") && name.endsWith(".xml"))
  } catch {
    return false
  }
  return (
    reports.length > 0 &&
    reports.every((name) => {
      const path = join(dir, name)
      const suite = /<testsuite\b[^>]*>/.exec(readFileSync(path, "utf8"))?.[0]
      const counts = suite === undefined ? [] : [...suite.matchAll(FAILED_COUNTS)].map((match) => Number(match[1]))
      return statSync(path).mtimeMs > sinceMs && counts.length > 0 && counts.every((count) => count === 0)
    })
  )
}

/** JaCoCo writes its rules only to the console, so nothing is snapshot before a run. */
export const jacocoReader: ReportReader = {
  snapshot: () => new Map(),
  read: (projectDir, _before, output) => readJacocoOutput(projectDir, output),
  recheck: jacocoRecheck,
}
