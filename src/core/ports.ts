import type { Report } from "./check.js"
import type { RuleFailure } from "./violation.js"

export interface CommandResult {
  exitCode: number
  /** The end of stdout and stderr, interleaved as they arrived. */
  output: string
}

/** Runs a check's `run` command in the project directory. */
export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>

/** Whether an executable, such as the Maven Daemon, is on the PATH. */
export type ExecutableLookup = (name: string) => boolean

/** Runs `work` while no other Interlint process runs checks on the same project. */
export type ProjectLock = <T>(projectDir: string, work: () => Promise<T>) => Promise<T>

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
  /** `output` is the end of the command's output, for reports that cannot say on their own why the command failed. */
  read(projectDir: string, before: ReportSnapshot, output: string): ReportResult
  /**
   * Whether the report also lists what the build accepted, such as warnings under the project's threshold.
   * Its failures then count only when the command failed.
   */
  alsoListsAccepted?: boolean
}

/** One reader per report format a check can declare. */
export type ReportReaders = Record<Report, ReportReader>
