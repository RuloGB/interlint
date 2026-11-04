import { formatNotices, formatOutcomes, formatPassed } from "./format-outcomes.js"
import type { ConfigSource } from "./ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./run-checks.js"

export interface CheckProjectDeps extends CheckDeps {
  loadConfig: ConfigSource
}

/**
 * At edit, the changed files the checks run for, and the lines the edit wrote in each of them: a file left out of
 * `linesWritten` wrote none. At task end, `changedOnly` runs only the projects that changed since their checks last
 * passed, and `files`, when given, only the projects that hold one of them.
 * Files are `/`-separated and relative to the project.
 */
export type CheckRequest =
  | { when: "edit"; files: string[]; linesWritten?: ReadonlyMap<string, number> }
  | { when: "task-end"; files?: string[]; changedOnly?: boolean }

/**
 * The checks' results, formatted. `report` holds the failures, for the agent: empty when every check passed.
 * `notice` holds what the user has to do, such as refreezing a broken FreezingArchRule store: empty when nothing.
 * `passed` names the checks that ran when they all passed: empty when none ran or one failed.
 */
export interface CheckResult {
  report: string
  notice: string
  passed: string
}

/** Runs the checks for the request and formats their failures for the agent and their notices for the user. */
export async function checkProject(projectDir: string, request: CheckRequest, deps: CheckProjectDeps): Promise<CheckResult> {
  const config = deps.loadConfig(projectDir)
  const outcomes =
    request.when === "edit"
      ? await runEditChecks(projectDir, config, request.files, deps, request.linesWritten)
      : await runTaskEndChecks(projectDir, config, deps, { changedOnly: request.changedOnly, files: request.files })
  return { report: formatOutcomes(outcomes), notice: formatNotices(outcomes), passed: formatPassed(outcomes) }
}
