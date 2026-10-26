#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { archUnitReader } from "./adapters/archunit/archunit.js"
import {
  decideStop,
  editNote,
  forgetSubagentFiles,
  HOOK_EXIT,
  HookInputError,
  parseHookInput,
  recordSubagentFiles,
  subagentFiles,
} from "./adapters/claude-code/hooks.js"
import { claudeCodeSettingsFile, SettingsError } from "./adapters/claude-code/settings.js"
import { type PlannedFile, stateOf, writeProjectFile } from "./adapters/files/project-files.js"
import { withProjectLock } from "./adapters/lock/project-lock.js"
import { mavenQualityReader } from "./adapters/maven/quality-reports.js"
import { runCommand } from "./adapters/process/command-runner.js"
import { lookupExecutable } from "./adapters/process/executable-lookup.js"
import { findMavenProjects, scanProject, TEST_SOURCES } from "./adapters/maven/project-scan.js"
import { openCodePluginFiles } from "./adapters/opencode/plugin-files.js"
import { fileChangeTracker } from "./adapters/state/change-tracker.js"
import { CONFIG_FILE, ConfigError, loadConfig, renderConfig } from "./adapters/yaml-config/config.js"
import { formatOutcomes } from "./core/format.js"
import { mavenCommand, type ProjectFacts, projectChecks, type QualityPlugin, runnableClasses } from "./core/init.js"
import { MAVEN_DAEMON } from "./core/maven.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./core/run-checks.js"

/** Exit codes shared by every agent integration. */
export const EXIT = { passed: 0, violations: 1, error: 2 } as const

const USAGE = `Usage:
  interlint init [--agent opencode|claude-code] [--force] [--cwd <dir>]
                                                               Detect the project's checks and write interlint.yaml
  interlint check [--when task-end] [--changed] [--file <path>...] [--cwd <dir>]
                                                               Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]   Run the edit checks for the changed files
  interlint hook claude-code post-edit|stop|subagent-stop      Claude Code hook: reads the hook's JSON on stdin

A check with dir runs in that directory (one Maven project of a workspace). An edit check runs
only when a changed file inside its project is one of its sources (*.java for report: archunit
and maven). With mvnd on the PATH, a check whose run starts with mvn, mvnw or ./mvnw runs with
mvnd instead; without mvnd, Maven edit checks wait for task-end.

--changed runs only the checks of the projects that changed since their checks last passed:
a file changed, or an edit check named one of its files. The agent integrations use it.
At task end, --file runs only the checks of the projects that hold one of those files: the agent
integrations pass the files a subagent changed, so it gets the failures of its own projects.

init writes an architecture check that runs the test classes with @ArchTest, with the Maven
Wrapper (or mvn) and when: edit, and a checkstyle and a pmd check (report: maven, when: task-end)
for the plugins in the build of pom.xml and its modules. In a directory without pom.xml it writes
the checks of each Maven project below it, with their dir. It never replaces a different
interlint.yaml without --force.

A report: maven check fails only when Maven fails, and shows the most severe level in the
Checkstyle and PMD reports, so nothing the project's build accepts is shown.
--agent opencode copies the plugin to .opencode/plugins/interlint/; --agent claude-code adds
the post-edit, stop and subagent-stop hooks to .claude/settings.json and keeps the rest of the file.

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.

A Claude Code hook exits as Claude Code expects instead: 0 nothing to report, 2 a check failed
(the failures go to the agent on stderr), 1 Interlint could not run (shown to the user, never a
block). stop blocks at most 3 times in a row, then lets the task end and shows the failures.
subagent-stop checks only the projects of the files that subagent changed, and runs nothing for
a subagent that changed none; after 3 blocks it lets the subagent stop, and stop gets the rest.
`

export interface Io {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The whole of stdin. Only hooks read it. */
  stdin?: () => Promise<string>
}

class UsageError extends Error {}

/** Wires the core to its adapters. This file is the only place that knows both. */
const DEPS: CheckDeps = {
  run: runCommand,
  readers: { archunit: archUnitReader, maven: mavenQualityReader },
  hasExecutable: lookupExecutable,
  lock: withProjectLock,
  changes: fileChangeTracker(),
  hasDirectory: isDirectory,
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
    if (command === "hook") return await hook(rest, io)
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  } catch (error) {
    reportError(error, io)
    return EXIT.error
  }
}

function reportError(error: unknown, io: Io) {
  if (error instanceof ConfigError || error instanceof UsageError || error instanceof HookInputError) {
    io.stderr(`interlint: ${error.message}\n`)
  } else {
    // A crash is reported here so the caller picks the exit code: left to Node, it exits with 1,
    // which means violations to `check` callers.
    io.stderr(`interlint: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`)
  }
}

async function check(args: string[], io: Io): Promise<number> {
  const { values } = parseCheckArgs(args)
  const when = values.when ?? "task-end"
  const files = values.file ?? []
  if (when !== "edit" && when !== "task-end") throw new UsageError(`--when must be edit or task-end (got "${when}")`)
  if (when === "edit" && files.length === 0) throw new UsageError("--when edit needs at least one --file <path>")
  if (when === "edit" && values.changed === true) throw new UsageError("--changed is only valid with --when task-end")

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const output =
    when === "edit"
      ? await runAndFormat(projectDir, "edit", projectFiles(io.cwd, projectDir, files))
      : await runAndFormat(
          projectDir,
          "task-end",
          // Files given but all outside the project hold no project, so nothing runs for them.
          files.length > 0 ? projectFiles(io.cwd, projectDir, files) : undefined,
          values.changed === true,
        )
  if (output === "") return EXIT.passed
  io.stdout(output)
  return EXIT.violations
}

/**
 * Runs the checks for `when` and formats their failures for the agent: empty when every check passed.
 * `changedOnly` runs at task end only the projects that changed since their checks last passed, and `changedFiles`,
 * when given, only the projects that hold one of them.
 */
async function runAndFormat(
  projectDir: string,
  when: "edit" | "task-end",
  changedFiles: string[] | undefined,
  changedOnly = false,
): Promise<string> {
  const config = loadConfig(projectDir)
  const outcomes =
    when === "edit"
      ? await runEditChecks(projectDir, config, changedFiles ?? [], DEPS)
      : await runTaskEndChecks(projectDir, config, DEPS, { changedOnly, files: changedFiles })
  return formatOutcomes(outcomes)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const HOOK_EVENTS = ["post-edit", "stop", "subagent-stop"] as const

/**
 * A Claude Code hook. Any error exits 1, never 2: Claude Code would read 2 as a block
 * and keep the agent going on a problem it cannot fix.
 */
async function hook(args: string[], io: Io): Promise<number> {
  try {
    const [agent, event, ...extra] = args
    if (agent !== "claude-code") throw new UsageError(`hook needs the agent claude-code (got "${agent ?? ""}")`)
    if (!(HOOK_EVENTS as readonly (string | undefined)[]).includes(event) || extra.length > 0) {
      const names = `${HOOK_EVENTS.slice(0, -1).join(", ")} and ${HOOK_EVENTS.at(-1)}`
      throw new UsageError(`claude-code hooks are ${names} (got "${args.slice(1).join(" ")}")`)
    }
    const input = parseHookInput(io.stdin ? await io.stdin() : "")
    const projectDir = resolve(io.cwd, process.env.CLAUDE_PROJECT_DIR || input.cwd || ".")

    if (event === "post-edit") {
      if (input.filePath === undefined) return HOOK_EXIT.pass
      const changed = projectFiles(input.cwd ?? io.cwd, projectDir, [input.filePath])
      // A subagent's changes are checked when it stops, and their failures go to it.
      recordSubagentFiles(input, changed)
      const output = await runAndFormat(projectDir, "edit", changed)
      if (output === "") return HOOK_EXIT.pass
      io.stderr(editNote(output))
      return HOOK_EXIT.block
    }

    if (event === "subagent-stop") {
      const files = subagentFiles(input)
      // A subagent that changed no file, such as a read-only reviewer, has nothing of its own to fix.
      if (files.length === 0) return HOOK_EXIT.pass
      const decision = decideStop(input, await runAndFormat(projectDir, "task-end", files, true))
      if (decision.action === "block") {
        io.stderr(decision.text)
        return HOOK_EXIT.block
      }
      // Passed, or still failing after the last attempt: then the main agent's stop, which checks every changed
      // project, gets the failures.
      forgetSubagentFiles(input)
      return HOOK_EXIT.pass
    }

    // Only the projects the agent changed since their checks last passed, as the OpenCode plugin does.
    const decision = decideStop(input, await runAndFormat(projectDir, "task-end", undefined, true))
    if (decision.action === "block") {
      io.stderr(decision.text)
      return HOOK_EXIT.block
    }
    // Past the limit the task may end, and the user still sees the failures.
    if (decision.action === "report") io.stdout(`${JSON.stringify({ systemMessage: decision.text })}\n`)
    return HOOK_EXIT.pass
  } catch (error) {
    reportError(error, io)
    return HOOK_EXIT.error
  }
}

/** The changed files as `/`-separated paths relative to the project. Files outside it are left out. */
function projectFiles(cwd: string, projectDir: string, files: string[]): string[] {
  return files
    .map((file) => relative(projectDir, resolve(cwd, file)))
    .filter((path) => path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    .map((path) => path.split(sep).join("/"))
}

const AGENTS = ["opencode", "claude-code"] as const
const QUALITY_TOOLS: Record<QualityPlugin, string> = { checkstyle: "Checkstyle", pmd: "PMD" }

function init(args: string[], io: Io): number {
  const { values } = parseInitArgs(args)
  const agent = values.agent
  if (agent !== undefined && !(AGENTS as readonly string[]).includes(agent)) {
    throw new UsageError(`--agent must be ${AGENTS.join(" or ")} (got "${agent}")`)
  }

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  if (!existsSync(projectDir)) throw new UsageError(`${projectDir} does not exist`)
  // The root itself when it has a pom.xml, or else each Maven project of the workspace, in its own directory.
  const projects = findMavenProjects(projectDir).map((dir) => ({
    dir: dir === "" ? undefined : dir,
    facts: scanProject(dir === "" ? projectDir : join(projectDir, dir)),
  }))
  const checks = projects.flatMap(({ dir, facts }) => projectChecks(facts, dir))
  if (checks.length === 0 && projects[0]?.dir === undefined) {
    throw new UsageError(
      `nothing to check: no file under ${TEST_SOURCES} contains @ArchTest, and the build in pom.xml has neither maven-checkstyle-plugin nor maven-pmd-plugin. Nothing was written.`,
    )
  }
  if (checks.length === 0) {
    throw new UsageError(
      `nothing to check: no Maven project has a file under ${TEST_SOURCES} with @ArchTest, or maven-checkstyle-plugin or maven-pmd-plugin in its build (found: ${projects.map(({ dir }) => dir).join(", ")}). Nothing was written.`,
    )
  }

  const files: PlannedFile[] = [
    { path: CONFIG_FILE, content: renderConfig({ checks }), replace: values.force === true },
    ...(agent === "opencode" ? openCodePluginFiles() : []),
    ...(agent === "claude-code" ? [claudeCodeSettings(projectDir)] : []),
  ]
  const states = files.map((file) => stateOf(projectDir, file))
  // No file is written while another one conflicts.
  const conflicts = files.filter((_, index) => states[index] === "conflict").map((file) => file.path)
  if (conflicts.length > 0) {
    const [verb, adjective] = conflicts.length === 1 ? ["exists", "is"] : ["exist", "are"]
    throw new UsageError(
      `${conflicts.join(", ")} already ${verb} and ${adjective} different from what init would write; rerun with --force to replace ${conflicts.length === 1 ? "it" : "them"}`,
    )
  }
  files.forEach((file, index) => {
    if (states[index] !== "unchanged") writeProjectFile(projectDir, file)
  })

  const single = projects.length === 1 && projects[0]?.dir === undefined
  const [check, runs] = single ? ["check", "runs"] : ["checks", "run"]
  const daemon = DEPS.hasExecutable(MAVEN_DAEMON)
    ? `on the PATH, so the architecture ${check} ${runs} after each edit`
    : `not on the PATH, so the architecture ${check} ${runs} at task end; install mvnd to run ${single ? "it" : "them"} after each edit`
  const detected = single
    ? ["Detected:", ...detectedLines(projects[0]!.facts, "  ")]
    : [
        `Detected ${projects.length} Maven projects:`,
        ...projects.flatMap(({ dir, facts }) => [`  ${dir}`, ...detectedLines(facts, "    ")]),
      ]
  const written = files.filter((_, index) => states[index] !== "unchanged").map((file) => file.path)
  const unchanged = files.filter((_, index) => states[index] === "unchanged").map((file) => file.path)
  io.stdout(
    [
      ...detected,
      ...(checks.some((check) => check.report === "archunit") ? [`  mvnd: ${daemon}`] : []),
      "",
      ...section("Wrote:", written),
      ...section("Unchanged:", unchanged),
    ].join("\n"),
  )
  return EXIT.passed
}

/** What `init` found in one project. In a workspace, a project with nothing to check says so. */
function detectedLines(facts: ProjectFacts, indent: string): string[] {
  if (projectChecks(facts).length === 0 && facts.archTestModules.length === 0) return [`${indent}nothing to check`]
  const modules = facts.archTestModules.filter((module) => module !== "")
  return [
    `${indent}ArchUnit tests: ${runnableClasses(facts).join(", ") || "none"}${modules.length > 0 ? ` (in ${modules.join(", ")})` : ""}`,
    ...facts.qualityPlugins.map((plugin) => `${indent}${QUALITY_TOOLS[plugin]}: maven-${plugin}-plugin in pom.xml, checked at task end`),
    `${indent}Maven: ${mavenCommand(facts)} (${facts.hasMavenWrapper ? "Maven Wrapper" : "no Maven Wrapper"})`,
  ]
}

function claudeCodeSettings(projectDir: string): PlannedFile {
  try {
    return claudeCodeSettingsFile(projectDir)
  } catch (error) {
    if (error instanceof SettingsError) throw new UsageError(`${error.message}. Nothing was written.`)
    throw error
  }
}

function section(title: string, paths: string[]): string[] {
  return paths.length === 0 ? [] : [title, ...paths.map((path) => `  ${path}`), ""]
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        when: { type: "string" },
        cwd: { type: "string" },
        file: { type: "string", multiple: true },
        changed: { type: "boolean" },
      },
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
    stdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString("utf8")
    },
  })
  process.exitCode = exitCode
}
