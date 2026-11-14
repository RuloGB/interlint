import type { CheckProjectDeps } from "../../../application/checking/check-project.js"
import type { FeedbackDeps } from "../../../application/feedback/agent-events.js"
import type { TranscriptModel } from "../../../application/feedback/ports.js"
import type { MetricsDeps } from "../../../application/metrics/show-metrics.js"
import type { InitDeps } from "../../../application/setup/init-project.js"
import { hook } from "../claude-code/hook-command.js"
import { copilotHook } from "../copilot/hook-command.js"
import { check } from "./check-command.js"
import { EXIT, type Io, reportError, UsageError } from "./cli-io.js"
import { init } from "./init-command.js"
import { metrics } from "./metrics-command.js"

const USAGE = `Usage:
  interlint init [--agent opencode|claude-code|copilot] [--force] [--cwd <dir>]
      Detect the project's checks, write interlint.yaml and set up the agent
  interlint check [--when task-end] [--changed] [--file <path>...] [--cwd <dir>]
      Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]
      Run the edit checks for the changed files
  interlint hook claude-code|copilot post-edit|stop|subagent-stop
      Agent hook: reads the hook's JSON on stdin
  interlint metrics [--all] [--since <YYYY-MM-DD>] [--agent claude-code|copilot|opencode] [--cwd <dir>]
      Sum up the metrics of the checks
  interlint metrics report [--out <path>] [--force] [--format md|html|pdf] [same options as metrics]
      Write the full metrics report, with charts
  interlint --version
      Print the installed version of Interlint

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
Hooks exit as their agent expects.

Docs: https://github.com/RuloGB/interlint/blob/main/docs/usage.md
`

/** The use cases the commands run, with their adapters. */
export interface CliDeps {
  checking: CheckProjectDeps
  feedback: FeedbackDeps
  /** The model in a GitHub Copilot session's transcript: `feedback` reads Claude Code's. */
  copilotTranscriptModel: TranscriptModel
  setup: InitDeps
  metrics: MetricsDeps
  /** The installed version of Interlint. */
  version: () => string
}

export async function runCli(args: string[], io: Io, deps: CliDeps): Promise<number> {
  try {
    const [command, ...rest] = args
    if (command === undefined || command === "--help" || command === "-h") {
      io.stdout(USAGE)
      return EXIT.passed
    }
    if (command === "--version" || command === "-v") {
      io.stdout(`${deps.version()}\n`)
      return EXIT.passed
    }
    if (command === "check") return await check(rest, io, deps.checking)
    if (command === "init") return init(rest, io, deps.setup)
    if (command === "hook" && rest[0] === "copilot") {
      return await copilotHook(rest, io, { ...deps.feedback, transcriptModel: deps.copilotTranscriptModel })
    }
    if (command === "hook") return await hook(rest, io, deps.feedback)
    if (command === "metrics") return metrics(rest, io, deps.metrics)
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  } catch (error) {
    reportError(error, io)
    return EXIT.error
  }
}
