import type { Check } from "../../domain/check.js"
import { npmChecks, projectChecks } from "../../domain/check-plan.js"
import { MAVEN_DAEMON } from "../../domain/maven-command.js"
import type { ExecutableLookup } from "../checking/ports.js"
import type {
  AgentFiles,
  ConfigFile,
  MavenProject,
  NpmProject,
  NpmProjectScanner,
  NpmScan,
  PlannedFile,
  ProjectFiles,
  ProjectScanner,
  ScannedProject,
} from "./ports.js"

export const AGENTS = ["opencode", "claude-code"] as const
export type Agent = (typeof AGENTS)[number]

export interface InitDeps {
  scan: ProjectScanner
  scanNpm: NpmProjectScanner
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
  /** `npm` says whether npm projects were looked for, and the `package.json` files that could not be read. */
  | { status: "nothing-to-check"; projects: ScannedProject[]; npm: Pick<NpmScan, "searched" | "unreadable"> }
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
  const npm = deps.scanNpm(projectDir)
  const projects = scannedProjects(deps.scan(projectDir), npm.projects)
  const checks = projects.flatMap(checksOf)
  if (checks.length === 0) {
    return { status: "nothing-to-check", projects, npm: { searched: npm.searched, unreadable: npm.unreadable } }
  }

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

function checksOf(project: ScannedProject): Check[] {
  return "npm" in project ? npmChecks(project.dir) : projectChecks(project.facts, project.dir)
}

/**
 * The Maven projects as their scanner gives them, or, when there is an npm project, both kinds sorted by directory.
 * Without a Maven project the Maven scanner gives the root as one with nothing to check (see `ProjectScanner`): it is
 * left out when there is an npm project, so `init` does not list a project that is not there.
 * Directories compare by code unit, as the scanners sort them, so the file is the same on every machine.
 */
function scannedProjects(maven: MavenProject[], npm: NpmProject[]): ScannedProject[] {
  if (npm.length === 0) return maven
  const real = maven.filter((project) => project.dir !== undefined || checksOf(project).length > 0)
  return [...real, ...npm].sort((a, b) => byCodeUnit(a.dir ?? "", b.dir ?? ""))
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
