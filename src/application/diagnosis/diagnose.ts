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

/** What a command runs with npx: the package it names, when it names one, and the executable it runs. */
export interface NpxTool {
  package?: string
  bin: string
}

/** Whether npx finds the tool installed from `cwd`: its executable in a `node_modules/.bin`, or its package installed. */
export type NpxToolLookup = (tool: NpxTool, cwd: string) => boolean

/** A file that is there but cannot be read, with why, such as `EACCES`. */
export interface UnreadableFile {
  unreadable: string
}

/**
 * A project file's text, by its `/`-separated path relative to the project: `undefined` when it is not there, and an
 * `UnreadableFile` when it is there but cannot be read.
 */
export type ProjectFileReader = (projectDir: string, path: string) => string | undefined | UnreadableFile

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
  findsNpxTool: NpxToolLookup
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
  const file = deps.readFile(projectDir, deps.configFile)
  if (file === undefined) {
    return { findings: [error(`${deps.configFile} not found`, "run `interlint init` to detect the checks and write it")] }
  }
  // Suggesting init here would replace a file the team wrote.
  if (typeof file !== "string") return { findings: [unreadable(deps.configFile, file)] }
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
  const tool = npxTool(check.run)
  const name = tool?.package ?? tool?.bin
  if (tool !== undefined && !deps.findsNpxTool(tool, dir)) {
    return error(
      `check ${check.name}: ${name} is not installed in node_modules`,
      `run \`npm install\`${check.dir === undefined ? "" : ` in ${check.dir}`}`,
    )
  }
  return ok(`check ${check.name}: ${name ?? program} is found`)
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
    const reads = planned.map((file) => ({ path: file.path, read: deps.readFile(projectDir, file.path) }))
    const present = reads.filter(({ read }) => read !== undefined)
    if (present.length === 0) continue
    const blocked = present.find(({ read }) => typeof read !== "string")
    if (blocked !== undefined) {
      findings.push(unreadable(`${name}: ${blocked.path}`, blocked.read as UnreadableFile))
      setUp = true
      continue
    }
    const stale = planned.filter((file) => deps.files.stateOf(projectDir, file) !== "unchanged").map((file) => file.path)
    if (stale.length === 0) {
      findings.push(ok(`${name}: ${planned.map((file) => file.path).join(", ")} ${planned.length === 1 ? "is" : "are"} up to date`))
      setUp = true
    } else if (!present.some(({ read }) => mentionsInterlint(read as string))) {
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

/**
 * Whether a file of an agent holds anything of Interlint's. A file without it is the project's own, such as Claude
 * Code settings without the hooks, and not an older setup of Interlint.
 */
function mentionsInterlint(text: string): boolean {
  return /interlint/i.test(text)
}

/**
 * What a command runs with npx. With `-p` or `--package`, the package it names and the executable after the options;
 * otherwise the first word after the options or `--`, a package spec whose executable npx takes from its name. The
 * version of a spec is left out. Nothing for a command that does not start with npx, or that runs a `-c` command.
 */
export function npxTool(command: string): NpxTool | undefined {
  const words = command.trim().split(/\s+/)
  if (words[0] !== "npx") return undefined
  let pkg: string | undefined
  let first: string | undefined
  for (let index = 1; index < words.length && first === undefined; index++) {
    const word = words[index]!
    if (word === "--") first = words[index + 1]
    else if (word === "-c" || word === "--call" || word.startsWith("--call=")) return undefined
    else if (word === "-p" || word === "--package") pkg = words[++index]
    else if (word.startsWith("--package=")) pkg = word.slice("--package=".length)
    else if (!word.startsWith("-")) first = word
  }
  if (first === undefined) return undefined
  if (pkg !== undefined) return { package: withoutVersion(pkg), bin: first }
  const name = withoutVersion(first)
  return { package: name, bin: name.replace(/^@[^/]+\//, "") }
}

/** A package spec without its version: `eslint@9` is `eslint`, `@scope/name@1` is `@scope/name`. */
function withoutVersion(spec: string): string {
  return /^(@[^/@]+\/[^@]+|[^@]+)/.exec(spec)?.[1] ?? spec
}

/** The program a command starts with, without the quotes around it. */
function firstWord(command: string): string | undefined {
  return /^\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;<>()]+))/.exec(command)?.slice(1).find((part) => part !== undefined)
}

function checkDirOf(projectDir: string, check: Check): string {
  return check.dir === undefined ? projectDir : `${projectDir}/${check.dir}`
}

function unreadable(subject: string, { unreadable }: UnreadableFile): Finding {
  return error(`${subject} cannot be read (${unreadable})`, "check that your user may read it")
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
