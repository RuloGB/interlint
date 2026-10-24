import type { Report } from "./check.js"
import type { RuleFailure } from "./violation.js"

export interface CommandResult {
  exitCode: number
  /** The end of stdout and stderr, interleaved as they arrived. */
  output: string
}

/** Runs a check's `run` command in the project directory. */
export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>

export interface ReportResult {
  /** Whether the run wrote any report at all. */
  found: boolean
  failures: RuleFailure[]
}

/** Report files present before a run, with a fingerprint of each (modification time and size). */
export type ReportSnapshot = ReadonlyMap<string, string>

/** Reads what one run of a check left behind. */
export interface ReportReader {
  snapshot(projectDir: string): ReportSnapshot
  read(projectDir: string, before: ReportSnapshot): ReportResult
}

/** One reader per report format a check can declare. */
export type ReportReaders = Record<Report, ReportReader>
