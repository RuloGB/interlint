import type { CheckProjectDeps } from "../../../application/checking/check-project.js"
import type { DoctorDeps } from "../../../application/diagnosis/diagnose.js"
import type { FeedbackDeps } from "../../../application/feedback/agent-events.js"
import type { TranscriptModel } from "../../../application/feedback/ports.js"
import type { MetricsDeps } from "../../../application/metrics/show-metrics.js"
import type { InitDeps } from "../../../application/setup/init-project.js"
import { hook } from "../claude-code/hook-command.js"
import { codexHook } from "../codex/hook-command.js"
import { copilotHook } from "../copilot/hook-command.js"
import { check } from "./check-command.js"
import { EXIT, type Io, reportError, UsageError } from "./cli-io.js"
import { doctor } from "./doctor-command.js"
import { init } from "./init-command.js"
import { lock } from "./lock-command.js"
import { metrics } from "./metrics-command.js"

const USAGE = `Usage:
  interlint init [--agent opencode|claude-code|copilot|codex] [--force] [--cwd <dir>]
      Detect the project's checks, write interlint.yaml and set up the agent
  interlint check [--when task-end] [--changed] [--file <path>...] [--cwd <dir>]
      Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]
      Run the edit checks for the changed files
  interlint doctor [--cwd <dir>]
      Tell whether Interlint works in this project and on this machine, and what to fix
  interlint hook claude-code|copilot|codex session-start|user-prompt|pre-edit|post-edit|stop|subagent-stop
      Agent hook: reads the hook's JSON on stdin (codex has no pre-edit)
  interlint metrics [--all] [--since <YYYY-MM-DD>] [--agent claude-code|codex|copilot|opencode] [--cwd <dir>]
      Sum up the metrics of the checks
  interlint metrics report [--out <path>] [--force] [--format md|html|pdf] [same options as metrics]
      Write the full metrics report, with charts
  interlint --version
      Print the installed version of Interlint

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
doctor exits 0 with no error (warnings allowed) and 1 with any error.
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
  doctor: DoctorDeps
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
    if (command === "check") return await check(rest, io, deps.checking, deps.feedback)
    if (command === "init") return init(rest, io, deps.setup)
    if (command === "doctor") return doctor(rest, io, deps.doctor)
    if (command === "lock") return await lock(rest, io, deps.checking.lock)
    if (command === "hook" && rest[0] === "copilot") {
      return await copilotHook(rest, io, { ...deps.feedback, transcriptModel: deps.copilotTranscriptModel })
    }
    // Codex gives the model in the hook's input, so it reads no transcript.
    if (command === "hook" && rest[0] === "codex") return await codexHook(rest, io, deps.feedback)
    if (command === "hook") return await hook(rest, io, deps.feedback)
    if (command === "metrics") return metrics(rest, io, deps.metrics)
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  } catch (error) {
    reportError(error, io)
    return EXIT.error
  }
}
