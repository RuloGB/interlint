#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { runTaskEndChecks } from "./check/run-checks.js"
import { ConfigError, loadConfig } from "./config/config.js"
import { formatOutcomes } from "./output/format.js"

/** Exit codes shared by every adapter. */
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
      return EXIT.error
    }
    throw error
  }
}

async function check(args: string[], io: Io): Promise<number> {
  const { values } = parseCheckArgs(args)
  const when = values.when ?? "task-end"
  if (when !== "task-end") throw new UsageError(`--when must be task-end (got "${when}")`)

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const outcomes = await runTaskEndChecks(projectDir, loadConfig(projectDir))
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
