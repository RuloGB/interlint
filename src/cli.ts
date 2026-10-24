#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { archUnitReader } from "./adapters/archunit/archunit.js"
import { runCommand } from "./adapters/process/command-runner.js"
import { lookupExecutable } from "./adapters/process/executable-lookup.js"
import { ConfigError, loadConfig } from "./adapters/yaml-config/config.js"
import { formatOutcomes } from "./core/format.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "./core/run-checks.js"

/** Exit codes shared by every agent integration. */
export const EXIT = { passed: 0, violations: 1, error: 2 } as const

const USAGE = `Usage:
  interlint check [--when task-end] [--cwd <dir>]              Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]   Run the edit checks for the changed files

An edit check runs only when a changed file inside the project is one of its sources
(*.java for report: archunit). With mvnd on the PATH, a check whose run starts with mvn,
mvnw or ./mvnw runs with mvnd instead; without mvnd, Maven edit checks wait for task-end.

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
`

export interface Io {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

class UsageError extends Error {}

/** Wires the core to its adapters. This file is the only place that knows both. */
const DEPS: CheckDeps = { run: runCommand, readers: { archunit: archUnitReader }, hasExecutable: lookupExecutable }

export async function main(args: string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = args
    if (command === undefined || command === "--help" || command === "-h") {
      io.stdout(USAGE)
      return EXIT.passed
    }
    if (command === "check") return await check(rest, io)
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
