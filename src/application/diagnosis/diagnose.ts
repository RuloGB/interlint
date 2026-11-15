import type { Check, Config } from "../../domain/check.js"
import { MAVEN_DAEMON, usesMaven } from "../../domain/maven-command.js"
import {
  ConfigError,
  type ConfigSource,
  type DirectoryLookup,
  type ExecutableLookup,
  type ProtectedFiles,
} from "../checking/ports.js"
import { AGENTS, type Agent } from "../setup/init-project.js"
import { type AgentFiles, AgentSetupError, type ProjectFiles } from "../setup/ports.js"

/** The oldest Node major version Interlint runs on, as `package.json` declares it. */
const MIN_NODE_MAJOR = 22

/** The agents as their users know them. */
const AGENT_NAMES: Record<Agent, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  codex: "Codex",
}

/** Whether the shell a check runs in finds the program `command` starts with, from `cwd`. */
export type CommandLookup = (command: string, cwd: string) => boolean

/** Whether an npm package's executable is in a `node_modules/.bin` of `cwd` or of a directory above it. */
export type PackageBinLookup = (name: string, cwd: string) => boolean

/** A project file's text, by its `/`-separated path relative to the project, or `undefined` when it is not there. */
export type ProjectFileReader = (projectDir: string, path: string) => string | undefined

/** Where Interlint keeps its state and metrics, and whether it may write there. */
export interface StateLocation {
  dir: string
  writable: boolean
}

export interface DoctorDeps {
  nodeVersion: () => string
  version: () => string
  /** The configuration file's name, relative to the project. */
  configFile: string
  loadConfig: ConfigSource
  readFile: ProjectFileReader
  hasDirectory: DirectoryLookup
  hasExecutable: ExecutableLookup
  findsCommand: CommandLookup
  findsPackageBin: PackageBinLookup
  agents: Record<Agent, AgentFiles>
  files: Pick<ProjectFiles, "stateOf">
  /** Tells where the state goes without creating anything. */
  state: () => StateLocation
  protectedFiles: ProtectedFiles
}

export type FindingStatus = "ok" | "warning" | "error"

export interface Finding {
  status: FindingStatus
  text: string
  /** What fixes it. Absent on a correct finding. */
  fix?: string
}

export interface DiagnosisSection {
  title: string
  findings: Finding[]
}

export interface Diagnosis {
  sections: DiagnosisSection[]
}

/**
 * Tells whether Interlint works in the project and on this machine, and what fixes what does not. It only reads: it
 * writes no file and runs no check, which is `interlint check`'s job.
 */
export function diagnose(projectDir: string, deps: DoctorDeps): Diagnosis {
  const agents = agentFindings(projectDir, deps)
  const environment = environmentFindings(deps, agents.setUp)
  const config = loadedConfig(projectDir, deps)
  const sections: DiagnosisSection[] = [
    { title: "Environment", findings: environment },
    { title: "Configuration", findings: config.findings },
    ...(config.value === undefined ? [] : [{ title: "Tools", findings: toolFindings(projectDir, config.value, deps) }]),
    { title: "Agents", findings: agents.findings },
    { title: "State", findings: [stateFinding(deps)] },
  ]
  const patterns = config.value?.protected ?? []
  if (patterns.length > 0) {
    sections.push({ title: "Protected files", findings: protectedFindings(projectDir, patterns, deps) })
  }
  return { sections }
}

export function hasErrors({ sections }: Diagnosis): boolean {
  return sections.some(({ findings }) => findings.some(({ status }) => status === "error"))
}

const SYMBOLS: Record<FindingStatus, string> = { ok: "✓", warning: "!", error: "✗" }

/** The findings by section, each with the fix under it, and how many errors and warnings there are. */
export function formatDiagnosis({ sections }: Diagnosis): string {
  const lines = sections.flatMap(({ title, findings }) => [
    title,
    ...findings.flatMap(({ status, text, fix }) => [
      `  ${SYMBOLS[status]} ${text}`,
      ...(fix === undefined ? [] : [`    → ${fix}`]),
    ]),
  ])
  const all = sections.flatMap(({ findings }) => findings)
  const errors = all.filter(({ status }) => status === "error").length
  const warnings = all.filter(({ status }) => status === "warning").length
  const summary =
    errors + warnings === 0
      ? "Everything is in order."
      : `${count(errors, "error")}, ${count(warnings, "warning")}.`
  return [...lines, "", summary, ""].join("\n")
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function environmentFindings(deps: DoctorDeps, agentSetUp: boolean): Finding[] {
  const node = deps.nodeVersion()
  const major = Number(node.split(".")[0])
  const findings: Finding[] = [
    major >= MIN_NODE_MAJOR
      ? ok(`Node ${node}`)
      : error(`Node ${node}: Interlint needs Node ${MIN_NODE_MAJOR} or later`, `install Node ${MIN_NODE_MAJOR} or later`),
    ok(`Interlint ${deps.version()}`),
  ]
  // The hooks and the OpenCode plugin run `interlint` from the PATH: without it they fail and the agent goes unchecked.
  if (agentSetUp) {
    findings.push(
      deps.hasExecutable("interlint")
        ? ok("interlint is on the PATH, where the agent's hooks run it")
        : error("interlint is not on the PATH, and the agent's hooks run it", "run `npm install -g interlint`"),
    )
  }
  return findings
}

function loadedConfig(projectDir: string, deps: DoctorDeps): { findings: Finding[]; value?: Config } {
  if (deps.readFile(projectDir, deps.configFile) === undefined) {
    return { findings: [error(`${deps.configFile} not found`, "run `interlint init` to detect the checks and write it")] }
  }
  let config: Config
  try {
    config = deps.loadConfig(projectDir)
  } catch (failure) {
    if (failure instanceof ConfigError) return { findings: [error(failure.message, `correct ${deps.configFile}`)] }
    throw failure
  }
  const missingDirs = config.checks
    .filter((check) => !deps.hasDirectory(checkDirOf(projectDir, check)))
    .map((check) => error(`check ${check.name}: its dir "${check.dir}" does not exist`, `correct its dir in ${deps.configFile}`))
  const findings =
    missingDirs.length > 0 ? missingDirs : [ok(`${deps.configFile} is valid, with ${count(config.checks.length, "check")}`)]
  return { findings, value: config }
}

function toolFindings(projectDir: string, config: Config, deps: DoctorDeps): Finding[] {
  const daemon = deps.hasExecutable(MAVEN_DAEMON)
  const checks = config.checks.filter((check) => deps.hasDirectory(checkDirOf(projectDir, check)))
  const findings = checks.map((check) => toolFinding(projectDir, check, daemon, deps))
  if (config.checks.some((check) => check.when === "edit" && usesMaven(check.run))) {
    findings.push(
      daemon
        ? ok("mvnd is on the PATH, so the Maven edit checks run after edits")
        : warning("mvnd is not on the PATH, so the Maven edit checks run at task end", "install mvnd to run them after edits"),
    )
  }
  return findings
}

/** Whether the program the check runs is on this machine, as the check would run it. */
function toolFinding(projectDir: string, check: Check, daemon: boolean, deps: DoctorDeps): Finding {
  // With mvnd on the PATH, `interlint check` runs every Maven check with it instead of the team's Maven.
  if (daemon && usesMaven(check.run)) return ok(`check ${check.name}: runs with ${MAVEN_DAEMON}`)
  const dir = checkDirOf(projectDir, check)
  const program = firstWord(check.run) ?? check.run
  if (!deps.findsCommand(check.run, dir)) {
    return error(
      `check ${check.name}: ${program} is not found`,
      `install it or put it on the PATH, or change the check's run in ${deps.configFile}`,
    )
  }
  const pkg = npxPackage(check.run)
  if (pkg !== undefined && !deps.findsPackageBin(pkg, dir)) {
    return error(
      `check ${check.name}: ${pkg} is not installed in node_modules`,
      `run \`npm install\`${check.dir === undefined ? "" : ` in ${check.dir}`}`,
    )
  }
  return ok(`check ${check.name}: ${pkg ?? program} is found`)
}

/**
 * Each agent with one of its files in the project, and whether any agent is set up. An agent's files are right when
 * they are what `init` would write now. A file with no mention of Interlint, such as the project's own Claude Code
 * settings, is only a warning: the team may not use that agent with Interlint.
 */
function agentFindings(projectDir: string, deps: DoctorDeps): { findings: Finding[]; setUp: boolean } {
  const findings: Finding[] = []
  let setUp = false
  for (const agent of AGENTS) {
    const name = AGENT_NAMES[agent]
    const fix = `run \`interlint init --agent ${agent}\``
    let planned
    try {
      planned = deps.agents[agent](projectDir)
    } catch (failure) {
      if (!(failure instanceof AgentSetupError)) throw failure
      findings.push(error(`${name}: ${failure.message}`, `correct it, then ${fix}`))
      setUp = true
      continue
    }
    const present = planned.filter((file) => deps.readFile(projectDir, file.path) !== undefined)
    if (present.length === 0) continue
    const stale = planned.filter((file) => deps.files.stateOf(projectDir, file) !== "unchanged").map((file) => file.path)
    if (stale.length === 0) {
      findings.push(ok(`${name}: ${planned.map((file) => file.path).join(", ")} ${planned.length === 1 ? "is" : "are"} up to date`))
      setUp = true
    } else if (!present.some((file) => /interlint/i.test(deps.readFile(projectDir, file.path) ?? ""))) {
      findings.push(warning(`${name}: ${present.map((file) => file.path).join(", ")} has no Interlint hooks`, fix))
    } else {
      findings.push(error(`${name}: ${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} missing or from another version of Interlint`, fix))
      setUp = true
    }
  }
  if (!setUp) findings.push(error("no agent is set up to run Interlint", `run \`interlint init --agent ${AGENTS.join("|")}\``))
  return { findings, setUp }
}

function stateFinding(deps: DoctorDeps): Finding {
  const { dir, writable } = deps.state()
  return writable
    ? ok(`${dir} can be written, for the state and the metrics`)
    : error(`${dir} cannot be written, so Interlint keeps no state or metrics`, "make it writable for your user")
}

function protectedFindings(projectDir: string, patterns: string[], deps: DoctorDeps): Finding[] {
  const unmatched = patterns.filter((pattern) => Object.keys(deps.protectedFiles(projectDir, [pattern])).length === 0)
  if (unmatched.length === 0) {
    const files = Object.keys(deps.protectedFiles(projectDir, patterns)).length
    return [ok(`${count(patterns.length, "pattern")} of protected match ${count(files, "file")}`)]
  }
  return unmatched.map((pattern) =>
    warning(`protected: ${pattern} matches no file`, `correct the path or glob in ${deps.configFile}`),
  )
}

/** The npm package a command runs with npx: the first word after `--`, or else after npx's options. */
export function npxPackage(command: string): string | undefined {
  const words = command.trim().split(/\s+/)
  if (words[0] !== "npx") return undefined
  const rest = words.slice(1)
  const end = rest.indexOf("--")
  const candidates = end === -1 ? rest.filter((word) => !word.startsWith("-")) : rest.slice(end + 1)
  return candidates[0]
}

/** The program a command starts with, without the quotes around it. */
function firstWord(command: string): string | undefined {
  return /^\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;<>()]+))/.exec(command)?.slice(1).find((part) => part !== undefined)
}

function checkDirOf(projectDir: string, check: Check): string {
  return check.dir === undefined ? projectDir : `${projectDir}/${check.dir}`
}

function ok(text: string): Finding {
  return { status: "ok", text }
}

function warning(text: string, fix: string): Finding {
  return { status: "warning", text, fix }
}

function error(text: string, fix: string): Finding {
  return { status: "error", text, fix }
}
