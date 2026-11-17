import type { Config } from "../../domain/check.js"
import type { AgentContext } from "../../domain/metric.js"
import {
  NOT_PAUSED_MESSAGE,
  type PauseMark,
  PAUSED_MESSAGE,
  PAUSED_REMINDER,
  pauseMarkOf,
  RESUMED_MESSAGE,
} from "../../domain/session-pause.js"
import {
  type CheckProjectDeps,
  type CheckResult,
  checkProject,
  restartSession,
  startSession,
  startTurn,
} from "../checking/check-project.js"
import { ConfigError } from "../checking/ports.js"
import { protectedAmong } from "../checking/protected-files.js"
import type { AgentRef, SessionMetrics, SessionPauses, StopCounter, SubagentFiles, TranscriptModel } from "./ports.js"
import { decideStop, type StopDecision, type StopRequest } from "./stop-policy.js"

export interface FeedbackDeps {
  checking: CheckProjectDeps
  subagentFiles: SubagentFiles
  stops: StopCounter
  transcriptModel: TranscriptModel
  pauses: SessionPauses
  sessionMetrics: SessionMetrics
}

/** What a hook gives in a session the user paused Interlint in: nothing at all. */
const NOTHING: CheckResult = { report: "", notice: "", passed: "", failed: [] }

/** Whether the user paused Interlint in the session. A hook without a session is never paused. */
function isPaused(session: string | undefined, deps: FeedbackDeps): boolean {
  return session !== undefined && session !== "" && deps.pauses.isPaused(session)
}

/** When the agent's session starts: keeps the protected files as they are, so its task end can tell what it changed. */
export function sessionStart(projectDir: string, context: AgentContext, deps: FeedbackDeps): void {
  if (isPaused(context.session, deps)) return
  startSession(projectDir, context, deps.checking)
}

/**
 * Before the agent's edit tool changes files, given relative to the project: the protected ones, which the user has to
 * approve. None when no file is protected, or in a session the user paused Interlint in.
 */
export function beforeEdit(projectDir: string, files: string[], deps: FeedbackDeps, session?: string): string[] {
  if (deps.checking.protection === undefined || files.length === 0 || isPaused(session, deps)) return []
  return protectedAmong(deps.checking.loadConfig(projectDir), files)
}

/**
 * After an agent changed files, given relative to the project with the lines it wrote in each: the edit checks'
 * report, empty when they pass, and their notice for the user.
 * A subagent's changes are also checked when it stops, and their failures go to it.
 * In a session the user paused Interlint in, nothing runs and nothing is recorded.
 */
export async function afterEdit(
  projectDir: string,
  agent: AgentRef,
  files: string[],
  deps: FeedbackDeps,
  linesWritten?: ReadonlyMap<string, number>,
  context?: AgentContext,
  asked = false,
): Promise<CheckResult> {
  if (isPaused(agent.sessionId, deps)) return NOTHING
  deps.subagentFiles.record(agent, files)
  return checkProject(projectDir, { when: "edit", files, linesWritten, agent: context, asked }, deps.checking)
}

/**
 * When a subagent stops: the task-end checks of the projects holding the files it changed. One that changed no file,
 * such as a read-only reviewer, has nothing of its own to fix. Unless the stop is blocked, its files are forgotten:
 * they passed, or after the last attempt the main agent's stop, which checks every changed project, gets them.
 * In a session the user paused Interlint in, it ends without a check.
 */
export async function subagentStop(
  projectDir: string,
  request: StopRequest,
  deps: FeedbackDeps,
  context?: AgentContext,
): Promise<StopOutcome> {
  if (isPaused(request.sessionId, deps)) return { decision: { action: "end" }, notice: "", passed: "" }
  const files = deps.subagentFiles.list(request)
  if (files.length === 0) return { decision: { action: "end" }, notice: "", passed: "" }
  const { report, notice, passed, failed } = await checkProject(
    projectDir,
    { when: "task-end", files, changedOnly: true, agent: context },
    deps.checking,
  )
  const decision = decideStop(request, report, failed, deps.stops)
  if (decision.action !== "block") deps.subagentFiles.forget(request)
  return { decision, notice, passed }
}

/**
 * When the main agent stops: the checks of the projects it changed since their checks last passed, and the protected
 * files it changed without the user's approval. `asked` tells that its edit tool asks the user before changing one.
 * In a session the user paused Interlint in, it ends without a check and reminds the user that Interlint is paused.
 */
export async function mainStop(
  projectDir: string,
  request: StopRequest,
  deps: FeedbackDeps,
  context?: AgentContext,
  asked = false,
): Promise<StopOutcome> {
  if (isPaused(request.sessionId, deps)) return { decision: { action: "end" }, notice: PAUSED_REMINDER, passed: "" }
  const { report, notice, passed, failed } = await checkProject(
    projectDir,
    { when: "task-end", changedOnly: true, agent: context, asked },
    deps.checking,
  )
  return { decision: decideStop(request, report, failed, deps.stops), notice, passed }
}

/**
 * When the user sends a prompt to the main agent: pauses or resumes Interlint in the session when the prompt holds
 * `interlint: pause` or `interlint: resume` (F26), and gives what the user reads about it. Empty without a mark, and
 * for a subagent's prompt, which the agent writes: nothing the agent writes pauses Interlint.
 * Resuming checks only what changes from then on: what changed while Interlint was paused is not the agent's to fix.
 * A prompt without a mark takes what changed since the agent's last turn ended as the user's, such as a `git pull`.
 */
export async function userPrompt(
  projectDir: string,
  prompt: string,
  agent: AgentRef,
  deps: FeedbackDeps,
  context?: AgentContext,
): Promise<string> {
  const mark = pauseMarkOf(prompt)
  const session = agent.sessionId
  if (agent.agentId !== undefined || session === "") return ""
  if (mark === undefined) {
    if (!deps.pauses.isPaused(session)) await userTurn(projectDir, session, deps)
    return ""
  }
  if (mark === "pause") {
    if (!deps.pauses.isPaused(session)) await pauseSession(projectDir, session, deps, context)
    return PAUSED_MESSAGE
  }
  if (!deps.pauses.isPaused(session)) return NOT_PAUSED_MESSAGE
  await resumeSession(projectDir, session, deps, context)
  return RESUMED_MESSAGE
}

/** Pauses Interlint in the main agent's session, and keeps the pause in the metrics. */
export async function pauseSession(projectDir: string, session: string, deps: FeedbackDeps, context?: AgentContext): Promise<void> {
  deps.pauses.pause(session)
  const config = configOf(projectDir, deps)
  if (config) await keepSessionMetric(projectDir, config, "pause", context, deps)
}

/**
 * Resumes Interlint in the main agent's session: its blocked stops count from zero and only what changes from now on
 * is checked. Keeps the resume in the metrics.
 */
export async function resumeSession(projectDir: string, session: string, deps: FeedbackDeps, context?: AgentContext): Promise<void> {
  deps.pauses.resume(session)
  deps.stops.clear({ sessionId: session })
  // Without a valid interlint.yaml there is nothing to restart: the next hook reports it.
  const config = configOf(projectDir, deps)
  if (config) {
    await restartSession(projectDir, config, session, deps.checking)
    await keepSessionMetric(projectDir, config, "resume", context, deps)
  }
}

/** Takes what changed since the main agent's last turn in `session` ended as the user's. */
export async function userTurn(projectDir: string, session: string, deps: FeedbackDeps): Promise<void> {
  // Without a valid interlint.yaml there is nothing to take: the next hook reports it.
  const config = configOf(projectDir, deps)
  if (config) await startTurn(projectDir, config, session, deps.checking)
}

function configOf(projectDir: string, deps: FeedbackDeps): Config | undefined {
  try {
    return deps.checking.loadConfig(projectDir)
  } catch (error) {
    if (error instanceof ConfigError) return undefined
    throw error
  }
}

/** Keeps a pause or resume in the metrics, under the project lock like the checks' metrics. Never throws. */
async function keepSessionMetric(
  projectDir: string,
  config: Config,
  event: PauseMark,
  context: AgentContext | undefined,
  deps: FeedbackDeps,
): Promise<void> {
  if (config.metrics === false) return
  try {
    await deps.checking.lock(projectDir, async () => deps.sessionMetrics(projectDir, { ...context, event }))
  } catch {
    // Lost on purpose: the pause never depends on its metrics.
  }
}

/**
 * What a stop does, the checks' notice for the user, and the checks that passed when they all did. Each text is empty
 * when there is none.
 */
export interface StopOutcome {
  decision: StopDecision
  notice: string
  passed: string
}
