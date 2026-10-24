#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { archUnitReader } from "./adapters/archunit/archunit.js"
import { type PlannedFile, stateOf, writeProjectFile } from "./adapters/files/project-files.js"
import { withProjectLock } from "./adapters/lock/project-lock.js"
import { runCommand } from "./adapters/process/command-runner.js"
import { lookupExecutable } from "./adapters/process/executable-lookup.js"
import { scanProject, TEST_SOURCES } from "./adapters/maven/project-scan.js"
import { openCodePluginFiles } from "./adapters/opencode/plugin-files.js"
import { CONFIG_FILE, ConfigError, loadConfig, renderConfig } from "./adapters/yaml-config/config.js"
import { formatOutcomes } from "./core/format.js"
import { architectureCheck, mavenCommand } from "./core/init.js"
import { MAVEN_DAEMON } from "./core/maven.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./core/run-checks.js"

/** Exit codes shared by every agent integration. */
export const EXIT = { passed: 0, violations: 1, error: 2 } as const

const USAGE = `Usage:
  interlint init [--agent opencode] [--force] [--cwd <dir>]    Detect the project's checks and write interlint.yaml
  interlint check [--when task-end] [--cwd <dir>]              Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]   Run the edit checks for the changed files

An edit check runs only when a changed file inside the project is one of its sources
(*.java for report: archunit). With mvnd on the PATH, a check whose run starts with mvn,
mvnw or ./mvnw runs with mvnd instead; without mvnd, Maven edit checks wait for task-end.

init writes an architecture check that runs the test classes with @ArchTest, with the Maven
Wrapper (or mvn) and when: edit. It never replaces a different interlint.yaml without --force.

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
`

export interface Io {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

class UsageError extends Error {}

/** Wires the core to its adapters. This file is the only place that knows both. */
const DEPS: CheckDeps = {
  run: runCommand,
  readers: { archunit: archUnitReader },
  hasExecutable: lookupExecutable,
  lock: withProjectLock,
}

export async function main(args: string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = args
    if (command === undefined || command === "--help" || command === "-h") {
      io.stdout(USAGE)
      return EXIT.passed
    }
    if (command === "check") return await check(rest, io)
    if (command === "init") return init(rest, io)
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) {
      io.stderr(`interlint: ${error.message}\n`)
    } else {
      // Node exits with 1 on a crash, which agent integrations would read as a violation.
      io.stderr(`interlint: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`)
    }
    return EXIT.error
  }
}

async function check(args: string[], io: Io): Promise<number> {
  const { values } = parseCheckArgs(args)
  const when = values.when ?? "task-end"
  const files = values.file ?? []
  if (when !== "edit" && when !== "task-end") throw new UsageError(`--when must be edit or task-end (got "${when}")`)
  if (when === "task-end" && files.length > 0) throw new UsageError("--file is only valid with --when edit")
  if (when === "edit" && files.length === 0) throw new UsageError("--when edit needs at least one --file <path>")

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const config = loadConfig(projectDir)
  const outcomes =
    when === "edit"
      ? await runEditChecks(projectDir, config, projectFiles(io.cwd, projectDir, files), DEPS)
      : await runTaskEndChecks(projectDir, config, DEPS)
  const output = formatOutcomes(outcomes)
  if (output === "") return EXIT.passed
  io.stdout(output)
  return EXIT.violations
}

/** The changed files as `/`-separated paths relative to the project. Files outside it are left out. */
function projectFiles(cwd: string, projectDir: string, files: string[]): string[] {
  return files
    .map((file) => relative(projectDir, resolve(cwd, file)))
    .filter((path) => path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    .map((path) => path.split(sep).join("/"))
}

const AGENTS = ["opencode"] as const

function init(args: string[], io: Io): number {
  const { values } = parseInitArgs(args)
  const agent = values.agent
  if (agent !== undefined && !(AGENTS as readonly string[]).includes(agent)) {
    throw new UsageError(`--agent must be ${AGENTS.join(" or ")} (got "${agent}")`)
  }

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const facts = scanProject(projectDir)
  const architecture = architectureCheck(facts)
  if (architecture === undefined) {
    throw new UsageError(
      `no ArchUnit tests found: no file under ${TEST_SOURCES} contains @ArchTest, so there is nothing to check. Nothing was written.`,
    )
  }

  const files: PlannedFile[] = [
    { path: CONFIG_FILE, content: renderConfig({ checks: [architecture] }), replace: values.force === true },
    ...(agent === "opencode" ? openCodePluginFiles() : []),
  ]
  const states = files.map((file) => stateOf(projectDir, file))
  // Nothing is written unless every file can be.
  if (states.includes("conflict")) {
    throw new UsageError(
      `${CONFIG_FILE} already exists and is different from what init would write; rerun with --force to replace it`,
    )
  }
  files.forEach((file, index) => {
    if (states[index] !== "unchanged") writeProjectFile(projectDir, file)
  })

  const maven = mavenCommand(facts)
  const daemon = DEPS.hasExecutable(MAVEN_DAEMON)
    ? "on the PATH, so the architecture check runs after each edit"
    : "not on the PATH, so the architecture check runs at task end; install mvnd to run it after each edit"
  const written = files.filter((_, index) => states[index] !== "unchanged").map((file) => file.path)
  const unchanged = files.filter((_, index) => states[index] === "unchanged").map((file) => file.path)
  io.stdout(
    [
      "Detected:",
      `  ArchUnit tests: ${[...facts.archTestClasses].sort().join(", ")}`,
      `  Maven: ${maven} (${facts.hasMavenWrapper ? "Maven Wrapper" : "no Maven Wrapper"})`,
      `  mvnd: ${daemon}`,
      "",
      ...section("Wrote:", written),
      ...section("Unchanged:", unchanged),
    ].join("\n"),
  )
  return EXIT.passed
}

function section(title: string, paths: string[]): string[] {
  return paths.length === 0 ? [] : [title, ...paths.map((path) => `  ${path}`), ""]
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { when: { type: "string" }, cwd: { type: "string" }, file: { type: "string", multiple: true } },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

function parseInitArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { agent: { type: "string" }, force: { type: "boolean" }, cwd: { type: "string" } },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

function isEntryPoint() {
  const entry = process.argv[1]
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

if (isEntryPoint()) {
  const exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
  process.exitCode = exitCode
}
