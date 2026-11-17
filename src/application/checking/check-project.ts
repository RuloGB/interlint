import type { Config } from "../../domain/check.js"
import type { AgentContext } from "../../domain/metric.js"
import { formatProtectedChanges, formatProtectedEdit, PROTECTED_CHECK } from "../../domain/protected-files.js"
import { formatNotices, formatOutcomes, formatPassed } from "./format-outcomes.js"
import type { ConfigSource, TurnEnds } from "./ports.js"
import {
  type ProtectionDeps,
  protectedEdit,
  protectedNow,
  protectedTaskEnd,
  recordProtectedChanges,
  renewBetweenTurns,
  renewProtection,
  startProtection,
} from "./protected-files.js"
import {
  type CheckDeps,
  projectsAtTurnEnd,
  restartTracking,
  runEditChecks,
  runTaskEndChecks,
  takeProjectsBetweenTurns,
} from "./run-checks.js"

export interface CheckProjectDeps extends CheckDeps {
  loadConfig: ConfigSource
  /** Absent, no file is protected. */
  protection?: ProtectionDeps
  /** Absent, what changes between two turns of a session is checked like what the agent changes. */
  turns?: TurnEnds
}

/**
 * At edit, the changed files the checks run for, and the lines the edit wrote in each of them: a file left out of
 * `linesWritten` wrote none. At task end, `changedOnly` runs only the projects that changed since their checks last
 * passed, and `files`, when given, only the projects that hold one of them.
 * Files are `/`-separated and relative to the project. `agent` tells who runs the checks, for their metrics.
 * `asked` tells that the agent's edit tool asks the user before it changes a protected file, so an edit of one was
 * approved. `rootSession` is the main agent's session, when `agent` names a subagent's own session, as in OpenCode:
 * the protected files are kept per main session.
 */
export type CheckRequest = (
  | { when: "edit"; files: string[]; linesWritten?: ReadonlyMap<string, number> }
  | { when: "task-end"; files?: string[]; changedOnly?: boolean }
) & { agent?: AgentContext; asked?: boolean; rootSession?: string }

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
    const unasked = protection ? await protectedEdit(projectDir, config, request.files, request.rootSession ?? request.agent?.session, request.asked === true, protection, deps.lock) : []
    if (unasked.length > 0) first = [formatProtectedEdit(unasked)]
    // An edit after the last turn ended, as in a turn the user interrupted, makes the turn's end no reference.
    const session = request.rootSession ?? request.agent?.session
    if (session !== undefined) deps.turns?.forget(projectDir, session)
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
    const { agent } = request
    if (request.changedOnly === true && request.files === undefined && agent?.session !== undefined && agent.subagent !== true) {
      await endTurn(projectDir, config, agent.session, deps)
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
 * When the user resumes Interlint in the main agent's `session` (F26): what changed while it was paused is taken as it
 * is, so only the changes from now on are checked. The session's task end skips a project until it changes, no
 * `edit` check waits for earlier edits, and the protected files are kept as they are now.
 */
export async function restartSession(projectDir: string, config: Config, session: string, deps: CheckProjectDeps): Promise<void> {
  await restartTracking(projectDir, config, session, deps)
  deps.turns?.forget(projectDir, session)
  const { protection } = deps
  if (protection) await deps.lock(projectDir, async () => renewProtection(projectDir, config, session, protection))
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

/**
 * When the main agent's turn ends in `session`: keeps the projects it leaves with nothing to check and the protected
 * files as they are, so the user's next prompt can tell what changed between the two turns.
 */
async function endTurn(projectDir: string, config: Config, session: string, deps: CheckProjectDeps): Promise<void> {
  const { turns, protection } = deps
  if (turns === undefined) return
  await deps.lock(projectDir, async () => {
    const projects = projectsAtTurnEnd(projectDir, config, session, deps)
    turns.save(projectDir, session, { projects, ...(protection ? { protected: protectedNow(projectDir, config, protection) } : {}) })
  })
}

/**
 * When the user sends a prompt to the main agent in `session`: what changed since the agent's last turn ended was not
 * the agent's doing, as a `git pull` or the user's own edits. The session's task end skips the projects it changed
 * until the agent changes them, and the protected files it changed become the reference. Nothing when no turn ended
 * since the last prompt or since an edit.
 */
export async function startTurn(projectDir: string, config: Config, session: string, deps: CheckProjectDeps): Promise<void> {
  const { turns, protection } = deps
  // Read first without the lock, so a prompt never waits for another session's checks when there is nothing to take.
  if (turns === undefined || turns.read(projectDir, session) === undefined) return
  // Read again under the lock, so a task end that saves a newer record meanwhile is never applied from a stale copy.
  await deps.lock(projectDir, async () => {
    const turnEnd = turns.read(projectDir, session)
    if (turnEnd === undefined) return
    takeProjectsBetweenTurns(projectDir, session, turnEnd.projects, deps)
    if (protection && turnEnd.protected) renewBetweenTurns(projectDir, config, session, turnEnd.protected, protection)
    turns.forget(projectDir, session)
  })
}
