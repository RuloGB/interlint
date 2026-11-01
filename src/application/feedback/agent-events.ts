import { type CheckProjectDeps, type CheckResult, checkProject } from "../checking/check-project.js"
import type { AgentRef, StopCounter, SubagentFiles } from "./ports.js"
import { decideStop, type StopDecision, type StopRequest } from "./stop-policy.js"

export interface FeedbackDeps {
  checking: CheckProjectDeps
  subagentFiles: SubagentFiles
  stops: StopCounter
}

/**
 * After an agent changed files, given relative to the project: the edit checks' report, empty when they pass, and
 * their notice for the user.
 * A subagent's changes are also checked when it stops, and their failures go to it.
 */
export async function afterEdit(projectDir: string, agent: AgentRef, files: string[], deps: FeedbackDeps): Promise<CheckResult> {
  deps.subagentFiles.record(agent, files)
  return checkProject(projectDir, { when: "edit", files }, deps.checking)
}

/**
 * When a subagent stops: the task-end checks of the projects holding the files it changed. One that changed no file,
 * such as a read-only reviewer, has nothing of its own to fix. Unless the stop is blocked, its files are forgotten:
 * they passed, or after the last attempt the main agent's stop, which checks every changed project, gets them.
 */
export async function subagentStop(projectDir: string, request: StopRequest, deps: FeedbackDeps): Promise<StopOutcome> {
  const files = deps.subagentFiles.list(request)
  if (files.length === 0) return { decision: { action: "end" }, notice: "" }
  const { report, notice } = await checkProject(projectDir, { when: "task-end", files, changedOnly: true }, deps.checking)
  const decision = decideStop(request, report, deps.stops)
  if (decision.action !== "block") deps.subagentFiles.forget(request)
  return { decision, notice }
}

/** When the main agent stops: the checks of the projects it changed since their checks last passed. */
export async function mainStop(projectDir: string, request: StopRequest, deps: FeedbackDeps): Promise<StopOutcome> {
  const { report, notice } = await checkProject(projectDir, { when: "task-end", changedOnly: true }, deps.checking)
  return { decision: decideStop(request, report, deps.stops), notice }
}

/** What a stop does, and the checks' notice for the user, empty when there is none. */
export interface StopOutcome {
  decision: StopDecision
  notice: string
}
