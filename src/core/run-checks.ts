import { type Check, type Config, isSourceOf } from "./check.js"
import { MAVEN_DAEMON, usesMaven, withMavenDaemon } from "./maven.js"
import type { CommandRunner, ExecutableLookup, ProjectLock, ReportReaders } from "./ports.js"
import type { RuleFailure } from "./violation.js"

export type CheckOutcome =
  | { check: Check; durationMs: number; status: "passed" }
  | { check: Check; durationMs: number; status: "violations"; failures: RuleFailure[] }
  | { check: Check; durationMs: number; status: "failed"; command: string; exitCode: number; outputTail: string }

const OUTPUT_TAIL_LINES = 30

/** The adapters a run needs, wired by the entry point. */
export interface CheckDeps {
  run: CommandRunner
  readers: ReportReaders
  hasExecutable: ExecutableLookup
  lock: ProjectLock
}

/** Runs the checks that apply at task end: all of them, `edit` ones included. */
export async function runTaskEndChecks(
  projectDir: string,
  config: Config,
  deps: CheckDeps,
): Promise<CheckOutcome[]> {
  return runChecks(projectDir, config.checks, deps)
}

/**
 * Runs the `edit` checks that verify one of the changed files, given relative to the project.
 * Without the Maven Daemon a Maven check is too slow for every edit, so it waits for task end (decision 12).
 */
export async function runEditChecks(
  projectDir: string,
  config: Config,
  changedFiles: string[],
  deps: CheckDeps,
): Promise<CheckOutcome[]> {
  const daemon = deps.hasExecutable(MAVEN_DAEMON)
  const checks = config.checks.filter(
    (check) =>
      check.when === "edit" &&
      changedFiles.some((file) => isSourceOf(check.report, file)) &&
      (daemon || !usesMaven(check.run)),
  )
  return runChecks(projectDir, checks, deps)
}

/**
 * Checks run one after another, under the project lock, because two builds must not share `target/` at the same time.
 * That holds across processes too: two edits in a row start two Interlint processes.
 */
async function runChecks(projectDir: string, checks: Check[], deps: CheckDeps): Promise<CheckOutcome[]> {
  if (checks.length === 0) return []
  const daemon = checks.some((check) => usesMaven(check.run)) && deps.hasExecutable(MAVEN_DAEMON)
  return deps.lock(projectDir, async () => {
    const outcomes: CheckOutcome[] = []
    for (const check of checks) {
      const command = daemon && usesMaven(check.run) ? withMavenDaemon(check.run) : check.run
      outcomes.push(await runCheck(projectDir, check, command, deps))
    }
    return outcomes
  })
}

async function runCheck(
  projectDir: string,
  check: Check,
  command: string,
  { run, readers }: CheckDeps,
): Promise<CheckOutcome> {
  const reader = readers[check.report]
  const before = reader.snapshot(projectDir)
  const startedAt = performance.now()
  const { exitCode, output } = await run(command, projectDir)
  const durationMs = Math.round(performance.now() - startedAt)
  const { found, failures } = reader.read(projectDir, before, output)

  // A report that also lists what the build accepted leaves the decision to the exit code: its failures count only
  // when the command failed, and a zero exit passes even without a report, since the build may skip the plugin.
  const exitCodeDecides = reader.alsoListsAccepted === true
  if (failures.length > 0 && (exitCode !== 0 || !exitCodeDecides)) {
    return { check, durationMs, status: "violations", failures }
  }
  // Without a fresh report, a zero exit code may mean the tests were skipped, not that they passed.
  if (exitCode !== 0 || (!found && !exitCodeDecides)) {
    return { check, durationMs, status: "failed", command, exitCode, outputTail: tail(output) }
  }
  return { check, durationMs, status: "passed" }
}

function tail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n")
}
