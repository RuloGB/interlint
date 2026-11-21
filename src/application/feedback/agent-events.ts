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
import type {
  AgentRef,
  SessionMetrics,
  SessionPauses,
  StopCounter,
  SubagentFiles,
  SubagentSnapshots,
  TranscriptModel,
} from "./ports.js"
import { decideStop, type StopDecision, type StopRequest } from "./stop-policy.js"

export interface FeedbackDeps {
  checking: CheckProjectDeps
  subagentFiles: SubagentFiles
  subagentSnapshots: SubagentSnapshots
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
 * When a subagent starts: keeps the fingerprint of each project's files, so its stop also checks the projects it
 * changed without an edit tool, such as through a shell command. Nothing for the main agent, or in a paused session.
 */
export function subagentStart(projectDir: string, agent: AgentRef, deps: FeedbackDeps): void {
  if (agent.agentId === undefined || isPaused(agent.sessionId, deps)) return
  deps.subagentSnapshots.save(agent, projectFingerprints(projectDir, deps))
}

/**
 * When a subagent stops: the task-end checks of the projects holding the files it changed with an edit tool, and of
 * the projects whose files changed, by any means, since it started. One that changed no file, such as a read-only
 * reviewer, has nothing of its own to fix. Unless the stop is blocked, its files are forgotten and the fingerprints
 * taken again for its next turn: they passed, or after the last attempt the main agent's stop, which checks every
 * changed project, gets them. In a session the user paused Interlint in, it ends without a check.
 */
export async function subagentStop(
  projectDir: string,
  request: StopRequest,
  deps: FeedbackDeps,
  context?: AgentContext,
): Promise<StopOutcome> {
  if (isPaused(request.sessionId, deps)) return { decision: { action: "end" }, notice: "", passed: "" }
  const snapshot = deps.subagentSnapshots.read(request)
  const files = filesToCheck(projectDir, snapshot, deps.subagentFiles.list(request), deps)
  if (files.length === 0) return { decision: { action: "end" }, notice: "", passed: "" }
  const { report, notice, passed, failed } = await checkProject(
    projectDir,
    { when: "task-end", files, changedOnly: true, agent: context },
    deps.checking,
  )
  const decision = decideStop(request, report, failed, deps.stops)
  if (decision.action !== "block") {
    deps.subagentFiles.forget(request)
    if (snapshot !== undefined) deps.subagentSnapshots.save(request, projectFingerprints(projectDir, deps))
  }
  return { decision, notice, passed }
}

/**
 * The files a subagent's task-end checks run for: `edited`, the files it changed with an edit tool, relative to the
 * project, and a marker for each project whose files changed, by any means, since its start was seen. Empty when it
 * changed nothing, so nothing runs.
 */
export function subagentCheckFiles(projectDir: string, agent: AgentRef, edited: readonly string[], deps: FeedbackDeps): string[] {
  return filesToCheck(projectDir, deps.subagentSnapshots.read(agent), edited, deps)
}

/**
 * The checks run for the projects that hold one of these: the files the subagent edited, and a marker for each project
 * it changed by other means since `snapshot`. None without a snapshot.
 */
function filesToCheck(
  projectDir: string,
  snapshot: Readonly<Record<string, string>> | undefined,
  edited: readonly string[],
  deps: FeedbackDeps,
): string[] {
  const changedProjects = snapshot === undefined ? [] : changedSince(projectDir, snapshot, deps)
  return [...new Set([...edited, ...changedProjects.map(projectMarker)])]
}

/** The root project, among the keys of a snapshot: the directory of `interlint.yaml`. */
const ROOT_PROJECT = "."

/**
 * The fingerprint of each project that has checks, by its `dir` or `.` for the root. A project seen for the first
 * time gets its files as they are as its reference, so a change made after this counts as one.
 */
function projectFingerprints(projectDir: string, deps: FeedbackDeps): Record<string, string> {
  const dirs = new Set(deps.checking.loadConfig(projectDir).checks.map((check) => check.dir ?? ROOT_PROJECT))
  const fingerprints: Record<string, string> = {}
  for (const dir of dirs) {
    const path = dir === ROOT_PROJECT ? projectDir : `${projectDir}/${dir}`
    if (deps.checking.hasDirectory(path)) fingerprints[dir] = deps.checking.changes.lookup(path).fingerprint
  }
  return fingerprints
}

/** The projects of the snapshot whose files changed since it was taken, by their `dir` or `.` for the root. */
function changedSince(projectDir: string, snapshot: Readonly<Record<string, string>>, deps: FeedbackDeps): string[] {
  const now = projectFingerprints(projectDir, deps)
  return Object.entries(snapshot)
    .filter(([dir, fingerprint]) => now[dir] !== undefined && now[dir] !== fingerprint)
    .map(([dir]) => dir)
}

/**
 * A path that the task-end checks place in the project of `dir`, `.` for the root, and in no other: they run for the
 * projects that hold one of their files. It names no real file, since the checks only read which project it is in.
 */
function projectMarker(dir: string): string {
  return dir === ROOT_PROJECT ? "." : `${dir}/.`
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
    await userTurn(projectDir, session, deps)
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

/**
 * Takes what changed since the main agent's last turn in `session` ended as the user's. Nothing in a paused session:
 * the resume takes everything as it is then.
 */
export async function userTurn(projectDir: string, session: string, deps: FeedbackDeps): Promise<void> {
  if (isPaused(session, deps)) return
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
