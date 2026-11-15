import type { AgentContext } from "../../domain/metric.js"
import { type CheckProjectDeps, type CheckResult, checkProject, startSession } from "../checking/check-project.js"
import { protectedAmong } from "../checking/protected-files.js"
import type { AgentRef, StopCounter, SubagentFiles, TranscriptModel } from "./ports.js"
import { decideStop, type StopDecision, type StopRequest } from "./stop-policy.js"

export interface FeedbackDeps {
  checking: CheckProjectDeps
  subagentFiles: SubagentFiles
  stops: StopCounter
  transcriptModel: TranscriptModel
}

/** When the agent's session starts: keeps the protected files as they are, so its task end can tell what it changed. */
export function sessionStart(projectDir: string, context: AgentContext, deps: FeedbackDeps): void {
  startSession(projectDir, context, deps.checking)
}

/**
 * Before the agent's edit tool changes files, given relative to the project: the protected ones, which the user has to
 * approve. None when no file is protected.
 */
export function beforeEdit(projectDir: string, files: string[], deps: FeedbackDeps): string[] {
  if (deps.checking.protection === undefined || files.length === 0) return []
  return protectedAmong(deps.checking.loadConfig(projectDir), files)
}

/**
 * After an agent changed files, given relative to the project with the lines it wrote in each: the edit checks'
 * report, empty when they pass, and their notice for the user.
 * A subagent's changes are also checked when it stops, and their failures go to it.
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
  deps.subagentFiles.record(agent, files)
  return checkProject(projectDir, { when: "edit", files, linesWritten, agent: context, asked }, deps.checking)
}

/**
 * When a subagent stops: the task-end checks of the projects holding the files it changed. One that changed no file,
 * such as a read-only reviewer, has nothing of its own to fix. Unless the stop is blocked, its files are forgotten:
 * they passed, or after the last attempt the main agent's stop, which checks every changed project, gets them.
 */
export async function subagentStop(
  projectDir: string,
  request: StopRequest,
  deps: FeedbackDeps,
  context?: AgentContext,
): Promise<StopOutcome> {
  const files = deps.subagentFiles.list(request)
  if (files.length === 0) return { decision: { action: "end" }, notice: "", passed: "" }
  const { report, notice, passed } = await checkProject(
    projectDir,
    { when: "task-end", files, changedOnly: true, agent: context },
    deps.checking,
  )
  const decision = decideStop(request, report, deps.stops)
  if (decision.action !== "block") deps.subagentFiles.forget(request)
  return { decision, notice, passed }
}

/**
 * When the main agent stops: the checks of the projects it changed since their checks last passed, and the protected
 * files it changed without the user's approval. `asked` tells that its edit tool asks the user before changing one.
 */
export async function mainStop(
  projectDir: string,
  request: StopRequest,
  deps: FeedbackDeps,
  context?: AgentContext,
  asked = false,
): Promise<StopOutcome> {
  const { report, notice, passed } = await checkProject(
    projectDir,
    { when: "task-end", changedOnly: true, agent: context, asked },
    deps.checking,
  )
  return { decision: decideStop(request, report, deps.stops), notice, passed }
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
