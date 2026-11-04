import type { Check } from "../../domain/check.js"
import { projectChecks } from "../../domain/check-plan.js"
import { MAVEN_DAEMON } from "../../domain/maven-command.js"
import type { ExecutableLookup } from "../checking/ports.js"
import type { AgentFiles, ConfigFile, PlannedFile, ProjectFiles, ProjectScanner, ScannedProject } from "./ports.js"

export const AGENTS = ["opencode", "claude-code"] as const
export type Agent = (typeof AGENTS)[number]

export interface InitDeps {
  scan: ProjectScanner
  files: ProjectFiles
  config: ConfigFile
  agents: Record<Agent, AgentFiles>
  hasExecutable: ExecutableLookup
}

export interface InitRequest {
  agent?: Agent
  /** Replaces a different config file. */
  force: boolean
}

export type InitResult =
  | { status: "nothing-to-check"; projects: ScannedProject[] }
  /** Nothing was written: these files exist, differ, and may not be replaced. */
  | { status: "conflicts"; paths: string[] }
  | {
      status: "written"
      projects: ScannedProject[]
      checks: Check[]
      written: string[]
      unchanged: string[]
      /** The user's different config, left as it is while the agent's files were updated. */
      kept: string[]
      daemonOnPath: boolean
    }

/**
 * Detects the checks of the project, or of each project below it, and writes them with the agent's files.
 * With an agent, a different config is kept and the agent's files are still written, so they can be updated
 * after the user edits the config.
 */
export function initProject(projectDir: string, { agent, force }: InitRequest, deps: InitDeps): InitResult {
  const projects = deps.scan(projectDir)
  const checks = projects.flatMap(({ dir, facts }) => projectChecks(facts, dir))
  if (checks.length === 0) return { status: "nothing-to-check", projects }

  const config: PlannedFile = { path: deps.config.path, content: deps.config.render({ checks }), replace: force }
  const agentFiles = agent === undefined ? [] : deps.agents[agent](projectDir)
  const keepConfig = agent !== undefined && deps.files.stateOf(projectDir, config) === "conflict"
  const kept = keepConfig ? [config.path] : []
  const files = keepConfig ? agentFiles : [config, ...agentFiles]
  const states = files.map((file) => deps.files.stateOf(projectDir, file))
  // No file is written while another one conflicts.
  const conflicts = files.filter((_, index) => states[index] === "conflict").map((file) => file.path)
  if (conflicts.length > 0) return { status: "conflicts", paths: conflicts }
  files.forEach((file, index) => {
    if (states[index] !== "unchanged") deps.files.write(projectDir, file)
  })

  return {
    status: "written",
    projects,
    checks,
    written: files.filter((_, index) => states[index] !== "unchanged").map((file) => file.path),
    unchanged: files.filter((_, index) => states[index] === "unchanged").map((file) => file.path),
    kept,
    daemonOnPath: deps.hasExecutable(MAVEN_DAEMON),
  }
}
