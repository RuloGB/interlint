#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { archUnitReader } from "./adapters/archunit/archunit.js"
import { runCommand } from "./adapters/process/command-runner.js"
import { ConfigError, loadConfig } from "./adapters/yaml-config/config.js"
import { formatOutcomes } from "./core/format.js"
import { type CheckDeps, runTaskEndChecks } from "./core/run-checks.js"

/** Exit codes shared by every agent integration. */
export const EXIT = { passed: 0, violations: 1, error: 2 } as const

const USAGE = `Usage:
  interlint check [--when task-end] [--cwd <dir>]   Run the checks in interlint.yaml

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
`

export interface Io {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

class UsageError extends Error {}

/** Wires the core to its adapters. This file is the only place that knows both. */
const DEPS: CheckDeps = { run: runCommand, readers: { archunit: archUnitReader } }

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
  if (when !== "task-end") throw new UsageError(`--when must be task-end (got "${when}")`)

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const outcomes = await runTaskEndChecks(projectDir, loadConfig(projectDir), DEPS)
  const output = formatOutcomes(outcomes)
  if (output === "") return EXIT.passed
  io.stdout(output)
  return EXIT.violations
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { when: { type: "string" }, cwd: { type: "string" } },
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
