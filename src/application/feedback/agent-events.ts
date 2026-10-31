import { type CheckProjectDeps, checkProject } from "../checking/check-project.js"
import type { AgentRef, StopCounter, SubagentFiles } from "./ports.js"
import { decideStop, type StopDecision, type StopRequest } from "./stop-policy.js"

export interface FeedbackDeps {
  checking: CheckProjectDeps
  subagentFiles: SubagentFiles
  stops: StopCounter
}

/**
 * After an agent changed files, given relative to the project: the edit checks' report, empty when they pass.
 * A subagent's changes are also checked when it stops, and their failures go to it.
 */
export async function afterEdit(projectDir: string, agent: AgentRef, files: string[], deps: FeedbackDeps) {
  deps.subagentFiles.record(agent, files)
  return checkProject(projectDir, { when: "edit", files }, deps.checking)
}

/**
 * When a subagent stops: the task-end checks of the projects holding the files it changed. One that changed no file,
 * such as a read-only reviewer, has nothing of its own to fix. Unless the stop is blocked, its files are forgotten:
 * they passed, or after the last attempt the main agent's stop, which checks every changed project, gets them.
 */
export async function subagentStop(projectDir: string, request: StopRequest, deps: FeedbackDeps): Promise<StopDecision> {
  const files = deps.subagentFiles.list(request)
  if (files.length === 0) return { action: "end" }
  const report = await checkProject(projectDir, { when: "task-end", files, changedOnly: true }, deps.checking)
  const decision = decideStop(request, report, deps.stops)
  if (decision.action !== "block") deps.subagentFiles.forget(request)
  return decision
}

/** When the main agent stops: the checks of the projects it changed since their checks last passed. */
export async function mainStop(projectDir: string, request: StopRequest, deps: FeedbackDeps): Promise<StopDecision> {
  const report = await checkProject(projectDir, { when: "task-end", changedOnly: true }, deps.checking)
  return decideStop(request, report, deps.stops)
}
