import type { AgentContext } from "../../domain/metric.js"
import { formatProtectedChanges, formatProtectedEdit, PROTECTED_CHECK } from "../../domain/protected-files.js"
import { formatNotices, formatOutcomes, formatPassed } from "./format-outcomes.js"
import type { ConfigSource } from "./ports.js"
import {
  type ProtectionDeps,
  protectedEdit,
  protectedTaskEnd,
  recordProtectedChanges,
  startProtection,
} from "./protected-files.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./run-checks.js"

export interface CheckProjectDeps extends CheckDeps {
  loadConfig: ConfigSource
  /** Absent, no file is protected. */
  protection?: ProtectionDeps
}

/**
 * At edit, the changed files the checks run for, and the lines the edit wrote in each of them: a file left out of
 * `linesWritten` wrote none. At task end, `changedOnly` runs only the projects that changed since their checks last
 * passed, and `files`, when given, only the projects that hold one of them.
 * Files are `/`-separated and relative to the project. `agent` tells who runs the checks, for their metrics.
 * `asked` tells that the agent's edit tool asks the user before it changes a protected file, so an edit of one was
 * approved.
 */
export type CheckRequest = (
  | { when: "edit"; files: string[]; linesWritten?: ReadonlyMap<string, number> }
  | { when: "task-end"; files?: string[]; changedOnly?: boolean }
) & { agent?: AgentContext; asked?: boolean }

/**
 * The checks' results, formatted. `report` holds the failures, for the agent: empty when every check passed.
 * `notice` holds what the user has to do, such as refreezing a broken FreezingArchRule store: empty when nothing.
 * `passed` names the checks that ran when they all passed: empty when none ran or one failed.
 */
export interface CheckResult {
  report: string
  notice: string
  passed: string
  /** The names of the checks that did not pass, each once: empty when every check passed. */
  failed: string[]
}

/**
 * Runs the checks for the request and formats their failures for the agent and their notices for the user.
 * The protected files changed without the user's approval come first, as a failure of their own.
 */
export async function checkProject(projectDir: string, request: CheckRequest, deps: CheckProjectDeps): Promise<CheckResult> {
  const config = deps.loadConfig(projectDir)
  const { protection } = deps
  let first: string[] = []
  let outcomes
  if (request.when === "edit") {
    outcomes = await runEditChecks(projectDir, config, request.files, deps, request.linesWritten, request.agent)
    const unasked = protection ? await protectedEdit(projectDir, config, request.files, request.agent, request.asked === true, protection, deps.lock) : []
    if (unasked.length > 0) first = [formatProtectedEdit(unasked)]
  } else {
    outcomes = await runTaskEndChecks(projectDir, config, deps, {
      changedOnly: request.changedOnly,
      files: request.files,
      agent: request.agent,
    })
    const changes = protection ? protectedTaskEnd(projectDir, config, request.agent, protection) : undefined
    if (changes) {
      first = [formatProtectedChanges(changes, request.asked === true)]
      await recordProtectedChanges(projectDir, config, changes, request.agent, deps.metrics, deps.lock)
    }
  }
  const failedChecks = outcomes.filter((outcome) => outcome.status !== "passed").map((outcome) => outcome.check.name)
  const failed = [...new Set([...(first.length > 0 ? [PROTECTED_CHECK] : []), ...failedChecks])]
  return {
    report: formatOutcomes(outcomes, first),
    notice: formatNotices(outcomes),
    passed: first.length > 0 ? "" : formatPassed(outcomes),
    failed,
  }
}

/**
 * When an agent's session starts: keeps the protected files as they are, so its task end can tell which it changed.
 * Nothing without a session.
 */
export function startSession(projectDir: string, agent: AgentContext | undefined, deps: CheckProjectDeps): void {
  const session = agent?.session
  if (session === undefined || deps.protection === undefined) return
  startProtection(projectDir, deps.loadConfig(projectDir), session, deps.protection)
}
