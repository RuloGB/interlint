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

/**
 * Remembers which projects changed since their checks last passed, so the agent's task end runs only those.
 * A project is the directory a check runs in.
 */
export interface ChangeTracker {
  /**
   * Whether the project changed since its checks last passed, or an edit touched it since. A project seen for the
   * first time counts as unchanged, and its files as they are become the reference.
   */
  lookup(projectDir: string): ProjectChange
  /**
   * Records that every check of the project passed with its files as they are now, unless an edit touched the
   * project after `seen` was looked up: that edit came while the checks ran, so they did not see it.
   */
  accept(projectDir: string, seen: ProjectChange): void
  /** Records that the agent changed a file of the project. */
  touch(projectDir: string): void
}

export interface ProjectChange {
  changed: boolean
  /** What the tracker held for the project when it was looked up, so `accept` can tell an edit came since. */
  record: string | undefined
}

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
   * The exit code then decides: its failures count only when the command failed, and a zero exit passes even
   * without a report.
   */
  alsoListsAccepted?: boolean
}

/** One reader per report format a check can declare. */
export type ReportReaders = Record<Report, ReportReader>
