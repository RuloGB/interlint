import { type Check, type Config, EDIT_SHOWS_CHANGED_FILES_ONLY, fromRoot, isInProjectOf, isSourceOf, type Report } from "../../domain/check.js"
import { MAVEN_DAEMON, usesMaven, withMavenDaemon } from "../../domain/maven-command.js"
import type { RuleFailure } from "../../domain/violation.js"
import type {
  BrokenClassRemover,
  BrokenStore,
  ChangeTracker,
  CommandResult,
  CommandRunner,
  DirectoryLookup,
  EditScope,
  ExecutableLookup,
  ProjectLock,
  ReportReader,
  ReportReaders,
  ReportResult,
} from "./ports.js"

export type CheckOutcome = (
  | { check: Check; durationMs: number; status: "passed" }
  | { check: Check; durationMs: number; status: "violations"; failures: RuleFailure[] }
  | { check: Check; durationMs: number; status: "failed"; command: string; exitCode: number; outputTail: string }
  | { check: Check; durationMs: number; status: "missing-dir" }
  | { check: Check; durationMs: number; status: "broken-build"; typesWithoutPackage: string[] }
) & {
  /** The FreezingArchRule stores written from broken classes, with paths from the root: for the user, not the agent. */
  brokenStores?: BrokenStore[]
}

const OUTPUT_TAIL_LINES = 30

/** The adapters a run needs, wired by the entry point. */
export interface CheckDeps {
  run: CommandRunner
  readers: ReportReaders
  hasExecutable: ExecutableLookup
  lock: ProjectLock
  changes: ChangeTracker
  hasDirectory: DirectoryLookup
  /** For the report formats whose tool can check only some files, how to limit its command at edit. */
  editScopes: Partial<Record<Report, EditScope>>
  removeBrokenClasses: BrokenClassRemover
}

export interface TaskEndOptions {
  /** Runs only the checks of the projects that changed since their checks last passed, as the agent's task end does. */
  changedOnly?: boolean
  /**
   * Runs only the projects that hold one of these files, relative to the project: those an agent changed,
   * so it gets the failures of its own projects only.
   */
  files?: string[]
}

/**
 * Runs the checks that apply at task end: all of them, `edit` ones included, or with `changedOnly` those of the
 * projects that changed, and with `files` only those of the projects that hold one of them.
 * A project whose checks all pass is remembered as passing, as it is now.
 * A check whose `dir` does not exist fails every time, changed or not, so a typo in `dir` never goes unnoticed;
 * the other projects still run.
 */
export async function runTaskEndChecks(
  projectDir: string,
  config: Config,
  deps: CheckDeps,
  { changedOnly = false, files }: TaskEndOptions = {},
): Promise<CheckOutcome[]> {
  return deps.lock(projectDir, async () => {
    const holds = (check: Check) => files === undefined || files.some((file) => isInProjectOf(check, file))
    const present = config.checks.filter((check) => holds(check) && deps.hasDirectory(checkDirOf(projectDir, check)))
    // Looked up before the checks run, so an edit made while they run keeps its project changed.
    const projects = [...new Set(present.map((check) => checkDirOf(projectDir, check)))].map((dir) => ({
      dir,
      seen: deps.changes.lookup(dir),
    }))
    const selected = changedOnly ? projects.filter(({ seen }) => seen.changed) : projects
    const dirs = selected.map(({ dir }) => dir)
    const checks = config.checks.filter(
      (check) => holds(check) && (!present.includes(check) || dirs.includes(checkDirOf(projectDir, check))),
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
 * A check whose tool can check only some files runs on the changed ones, and a check whose report rates each file on
 * its own shows only their failures (`EDIT_SHOWS_CHANGED_FILES_ONLY`).
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
  return deps.lock(projectDir, () => runInOrder(projectDir, checks, deps, changedFiles))
}

/** The directory a check runs in: its `dir` inside the project, or the project itself. */
function checkDirOf(projectDir: string, check: Check): string {
  return check.dir === undefined ? projectDir : `${projectDir}/${check.dir}`
}

/**
 * Checks run one after another, under the project lock, because two builds must not share `target/` at the same time.
 * That holds across processes too: two edits in a row start two Interlint processes.
 * `changedFiles`, given at edit only, are the files the checks run for.
 */
async function runInOrder(
  projectDir: string,
  checks: Check[],
  deps: CheckDeps,
  changedFiles?: string[],
): Promise<CheckOutcome[]> {
  const daemon = checks.some((check) => usesMaven(check.run)) && deps.hasExecutable(MAVEN_DAEMON)
  const outcomes: CheckOutcome[] = []
  for (const check of checks) {
    if (!deps.hasDirectory(checkDirOf(projectDir, check))) {
      outcomes.push({ check, durationMs: 0, status: "missing-dir" })
      continue
    }
    const command = daemon && usesMaven(check.run) ? withMavenDaemon(check.run) : check.run
    const edited = changedFiles?.filter((file) => isInProjectOf(check, file) && isSourceOf(check.report, file))
    if (edited === undefined) {
      outcomes.push(await runCheck(projectDir, check, command, deps))
      continue
    }
    const scope = deps.editScopes[check.report]
    const files = edited.map((file) => inProject(check, file))
    const scoped = scope ? scope(command, files, checkDirOf(projectDir, check)) : command
    const onlyFiles = EDIT_SHOWS_CHANGED_FILES_ONLY[check.report] ? edited : undefined
    outcomes.push(await runCheck(projectDir, check, scoped, deps, onlyFiles))
  }
  return outcomes
}

/** `file`, relative to the directory of `interlint.yaml` and inside the check's project, relative to that project. */
function inProject(check: Check, file: string): string {
  return check.dir === undefined ? file : file.slice(check.dir.length + 1)
}

/**
 * Runs one check in its own directory. Its reports are read there, and their paths given from `projectDir`.
 * With `onlyFiles`, relative to `projectDir`, only the failures in those files are shown.
 *
 * A Maven check first removes the classes an IDE compiled with errors, so Maven compiles them again. An IDE that
 * builds automatically can still write some while the check runs: when the check fails and such classes appeared,
 * they are removed and the check runs once more, and that run is the one shown.
 */
async function runCheck(
  projectDir: string,
  check: Check,
  command: string,
  deps: CheckDeps,
  onlyFiles?: string[],
): Promise<CheckOutcome> {
  const checkDir = checkDirOf(projectDir, check)
  const maven = usesMaven(command)
  if (maven) deps.removeBrokenClasses(checkDir)
  const first = await attempt(checkDir, check, command, deps)
  const failed = first.exitCode !== 0 || first.typesWithoutPackage !== undefined
  const retry = maven && failed && deps.removeBrokenClasses(checkDir).length > 0
  const result = retry ? await attempt(checkDir, check, command, deps) : first
  if (retry) result.durationMs += first.durationMs
  return outcomeOf(check, command, deps.readers[check.report], result, onlyFiles)
}

interface Attempt extends CommandResult, ReportResult {
  durationMs: number
}

async function attempt(checkDir: string, check: Check, command: string, { run, readers }: CheckDeps): Promise<Attempt> {
  const reader = readers[check.report]
  const before = reader.snapshot(checkDir)
  const startedAt = performance.now()
  const { exitCode, output } = await run(command, checkDir)
  const durationMs = Math.round(performance.now() - startedAt)
  return { exitCode, output, durationMs, ...reader.read(checkDir, before, output) }
}

function outcomeOf(
  check: Check,
  command: string,
  reader: ReportReader,
  attempt: Attempt,
  onlyFiles?: string[],
): CheckOutcome {
  const outcome = agentOutcomeOf(check, command, reader, attempt, onlyFiles)
  const brokenStores = attempt.brokenStores?.map((store) => ({ ...store, path: fromRoot(check, store.path) }))
  return brokenStores === undefined ? outcome : { ...outcome, brokenStores }
}

function agentOutcomeOf(
  check: Check,
  command: string,
  reader: ReportReader,
  { exitCode, output, durationMs, found, failures, typesWithoutPackage, brokenStores, otherFailure }: Attempt,
  onlyFiles?: string[],
): CheckOutcome {
  // Violations read from broken classes are not the agent's: showing them would send it to fix code that is fine.
  if (typesWithoutPackage !== undefined) return { check, durationMs, status: "broken-build", typesWithoutPackage }

  // A report that also lists what the build accepted leaves the decision to the exit code: its failures count only
  // when the command failed, and a zero exit passes even without a report, since the build may skip the plugin.
  const exitCodeDecides = reader.alsoListsAccepted === true
  const all = failures.map((failure) => withPathsFromRoot(check, failure))
  const shown = onlyFiles === undefined ? all : inFiles(all, onlyFiles)
  if (shown.length > 0 && (exitCode !== 0 || !exitCodeDecides)) {
    return { check, durationMs, status: "violations", failures: shown }
  }
  // At edit, failures all in files the edit did not change are not the edit's: task end reports them.
  if (all.length > 0 && shown.length === 0) return { check, durationMs, status: "passed" }
  // A run that failed only on violations frozen in a broken store failed on the team's accepted debt, not the agent's.
  // A run that also failed for another reason, such as a module that does not compile, is still a failure.
  const onlyFrozen = all.length === 0 && otherFailure !== true && brokenStores?.some(({ hidden }) => hidden > 0)
  if (onlyFrozen) return { check, durationMs, status: "passed" }
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

/** The failures with only their violations in `files`, leaving out the failures left with none. */
function inFiles(failures: RuleFailure[], files: string[]): RuleFailure[] {
  return failures
    .map((failure) => ({
      ...failure,
      violations: failure.violations.filter((violation) => violation.path !== undefined && files.includes(violation.path)),
    }))
    .filter((failure) => failure.violations.length > 0)
}

function tail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n")
}
