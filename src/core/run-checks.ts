import type { Check, Config } from "./check.js"
import type { CommandRunner, ReportReaders } from "./ports.js"
import type { RuleFailure } from "./violation.js"

export type CheckOutcome =
  | { check: Check; durationMs: number; status: "passed" }
  | { check: Check; durationMs: number; status: "violations"; failures: RuleFailure[] }
  | { check: Check; durationMs: number; status: "failed"; exitCode: number; outputTail: string }

const OUTPUT_TAIL_LINES = 30

/** The adapters a run needs, wired by the entry point. */
export interface CheckDeps {
  run: CommandRunner
  readers: ReportReaders
}

/**
 * Runs the checks that apply at task end: all of them, `edit` ones included.
 * Checks run one after another, because two builds must not share `target/` at the same time.
 */
export async function runTaskEndChecks(
  projectDir: string,
  config: Config,
  deps: CheckDeps,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const check of config.checks) outcomes.push(await runCheck(projectDir, check, deps))
  return outcomes
}

async function runCheck(projectDir: string, check: Check, { run, readers }: CheckDeps): Promise<CheckOutcome> {
  const reader = readers[check.report]
  const before = reader.snapshot(projectDir)
  const startedAt = performance.now()
  const { exitCode, output } = await run(check.run, projectDir)
  const durationMs = Math.round(performance.now() - startedAt)
  const { found, failures } = reader.read(projectDir, before)

  if (failures.length > 0) return { check, durationMs, status: "violations", failures }
  // Without a fresh report, a zero exit code may mean the tests were skipped, not that they passed.
  if (exitCode !== 0 || !found) return { check, durationMs, status: "failed", exitCode, outputTail: tail(output) }
  return { check, durationMs, status: "passed" }
}

function tail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n")
}
