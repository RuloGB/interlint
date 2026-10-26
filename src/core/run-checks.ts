import { type Check, type Config, fromRoot, isInProjectOf, isSourceOf } from "./check.js"
import { MAVEN_DAEMON, usesMaven, withMavenDaemon } from "./maven.js"
import type {
  ChangeTracker,
  CommandRunner,
  DirectoryLookup,
  ExecutableLookup,
  ProjectLock,
  ReportReaders,
} from "./ports.js"
import type { RuleFailure } from "./violation.js"

export type CheckOutcome =
  | { check: Check; durationMs: number; status: "passed" }
  | { check: Check; durationMs: number; status: "violations"; failures: RuleFailure[] }
  | { check: Check; durationMs: number; status: "failed"; command: string; exitCode: number; outputTail: string }
  | { check: Check; durationMs: number; status: "missing-dir" }

const OUTPUT_TAIL_LINES = 30

/** The adapters a run needs, wired by the entry point. */
export interface CheckDeps {
  run: CommandRunner
  readers: ReportReaders
  hasExecutable: ExecutableLookup
  lock: ProjectLock
  changes: ChangeTracker
  hasDirectory: DirectoryLookup
}

export interface TaskEndOptions {
  /** Runs only the checks of the projects that changed since their checks last passed, as the agent's task end does. */
  changedOnly?: boolean
}

/**
 * Runs the checks that apply at task end: all of them, `edit` ones included, or with `changedOnly` those of the
 * projects that changed. A project whose checks all pass is remembered as passing, as it is now.
 * A check whose `dir` does not exist fails every time, changed or not, so a typo in `dir` never goes unnoticed;
 * the other projects still run.
 */
export async function runTaskEndChecks(
  projectDir: string,
  config: Config,
  deps: CheckDeps,
  { changedOnly = false }: TaskEndOptions = {},
): Promise<CheckOutcome[]> {
  return deps.lock(projectDir, async () => {
    const present = config.checks.filter((check) => deps.hasDirectory(checkDirOf(projectDir, check)))
    // Looked up before the checks run, so an edit made while they run keeps its project changed.
    const projects = [...new Set(present.map((check) => checkDirOf(projectDir, check)))].map((dir) => ({
      dir,
      seen: deps.changes.lookup(dir),
    }))
    const selected = changedOnly ? projects.filter(({ seen }) => seen.changed) : projects
    const dirs = selected.map(({ dir }) => dir)
    const checks = config.checks.filter(
      (check) => !present.includes(check) || dirs.includes(checkDirOf(projectDir, check)),
    )
    const outcomes = await runInOrder(projectDir, checks, deps)
    for (const { dir, seen } of selected) {
      const ofProject = outcomes.filter((outcome) => checkDirOf(projectDir, outcome.check) === dir)
      if (ofProject.every((outcome) => outcome.status === "passed")) deps.changes.accept(dir, seen)
    }
    return outcomes
  })
}

/**
 * Runs the `edit` checks that verify one of the changed files, given relative to the project: a check
 * runs when a changed file is inside its `dir` and is one of its sources. Every project with a changed file,
 * a source or not, is marked as changed, so its checks run at task end. A check whose `dir` does not exist is
 * left to task end, which reports it, so it does not block every edit.
 * Without the Maven Daemon a Maven check is too slow for every edit, so it waits for task end (decision 12).
 */
export async function runEditChecks(
  projectDir: string,
  config: Config,
  changedFiles: string[],
  deps: CheckDeps,
): Promise<CheckOutcome[]> {
  const touched = config.checks.filter(
    (check) =>
      changedFiles.some((file) => isInProjectOf(check, file)) && deps.hasDirectory(checkDirOf(projectDir, check)),
  )
  for (const dir of new Set(touched.map((check) => checkDirOf(projectDir, check)))) deps.changes.touch(dir)

  const daemon = deps.hasExecutable(MAVEN_DAEMON)
  const checks = touched.filter(
    (check) =>
      check.when === "edit" &&
      changedFiles.some((file) => isInProjectOf(check, file) && isSourceOf(check.report, file)) &&
      (daemon || !usesMaven(check.run)),
  )
  if (checks.length === 0) return []
  return deps.lock(projectDir, () => runInOrder(projectDir, checks, deps))
}

/** The directory a check runs in: its `dir` inside the project, or the project itself. */
function checkDirOf(projectDir: string, check: Check): string {
  return check.dir === undefined ? projectDir : `${projectDir}/${check.dir}`
}

/**
 * Checks run one after another, under the project lock, because two builds must not share `target/` at the same time.
 * That holds across processes too: two edits in a row start two Interlint processes.
 */
async function runInOrder(projectDir: string, checks: Check[], deps: CheckDeps): Promise<CheckOutcome[]> {
  const daemon = checks.some((check) => usesMaven(check.run)) && deps.hasExecutable(MAVEN_DAEMON)
  const outcomes: CheckOutcome[] = []
  for (const check of checks) {
    if (!deps.hasDirectory(checkDirOf(projectDir, check))) {
      outcomes.push({ check, durationMs: 0, status: "missing-dir" })
      continue
    }
    const command = daemon && usesMaven(check.run) ? withMavenDaemon(check.run) : check.run
    outcomes.push(await runCheck(projectDir, check, command, deps))
  }
  return outcomes
}

/** Runs one check in its own directory. Its reports are read there, and their paths given from `projectDir`. */
async function runCheck(
  projectDir: string,
  check: Check,
  command: string,
  { run, readers }: CheckDeps,
): Promise<CheckOutcome> {
  const reader = readers[check.report]
  const checkDir = checkDirOf(projectDir, check)
  const before = reader.snapshot(checkDir)
  const startedAt = performance.now()
  const { exitCode, output } = await run(command, checkDir)
  const durationMs = Math.round(performance.now() - startedAt)
  const { found, failures } = reader.read(checkDir, before, output)

  // A report that also lists what the build accepted leaves the decision to the exit code: its failures count only
  // when the command failed, and a zero exit passes even without a report, since the build may skip the plugin.
  const exitCodeDecides = reader.alsoListsAccepted === true
  if (failures.length > 0 && (exitCode !== 0 || !exitCodeDecides)) {
    return { check, durationMs, status: "violations", failures: failures.map((failure) => withPathsFromRoot(check, failure)) }
  }
  // Without a fresh report, a zero exit code may mean the tests were skipped, not that they passed.
  if (exitCode !== 0 || (!found && !exitCodeDecides)) {
    return { check, durationMs, status: "failed", command, exitCode, outputTail: tail(output) }
  }
  return { check, durationMs, status: "passed" }
}

function withPathsFromRoot(check: Check, failure: RuleFailure): RuleFailure {
  return {
    ...failure,
    violations: failure.violations.map((violation) =>
      violation.path === undefined ? violation : { ...violation, path: fromRoot(check, violation.path) },
    ),
  }
}

function tail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n")
}
