import { formatOutcomes } from "./format-outcomes.js"
import type { ConfigSource } from "./ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./run-checks.js"

export interface CheckProjectDeps extends CheckDeps {
  loadConfig: ConfigSource
}

/**
 * At edit, the changed files the checks run for. At task end, `changedOnly` runs only the projects that changed since
 * their checks last passed, and `files`, when given, only the projects that hold one of them.
 * Files are `/`-separated and relative to the project.
 */
export type CheckRequest =
  | { when: "edit"; files: string[] }
  | { when: "task-end"; files?: string[]; changedOnly?: boolean }

/** Runs the checks for the request and formats their failures for the agent: empty when every check passed. */
export async function checkProject(projectDir: string, request: CheckRequest, deps: CheckProjectDeps): Promise<string> {
  const config = deps.loadConfig(projectDir)
  const outcomes =
    request.when === "edit"
      ? await runEditChecks(projectDir, config, request.files, deps)
      : await runTaskEndChecks(projectDir, config, deps, { changedOnly: request.changedOnly, files: request.files })
  return formatOutcomes(outcomes)
}
