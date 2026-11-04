import type { Config, Report } from "../../domain/check.js"
import type { RuleFailure } from "../../domain/violation.js"

/** Reads the project's `interlint.yaml`. Throws `ConfigError` when it is missing or invalid. */
export type ConfigSource = (projectDir: string) => Config

export class ConfigError extends Error {}

export interface CommandResult {
  exitCode: number
  /** The end of stdout and stderr, interleaved as they arrived. */
  output: string
}

/** Runs a check's `run` command in the project directory. */
export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>

/** Whether an executable, such as the Maven Daemon, is on the PATH. */
export type ExecutableLookup = (name: string) => boolean

/** Whether a directory, such as the `dir` of a check, exists. */
export type DirectoryLookup = (path: string) => boolean

/**
 * Deletes the class files of a project and its modules that were compiled with errors, and returns their paths.
 * javac never writes such a class; an IDE's Eclipse compiler does, into the same `target/` as Maven, and Maven
 * keeps it while it is newer than its source. Once deleted, the next build compiles it again with javac.
 */
export type BrokenClassRemover = (projectDir: string) => string[]

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
   * Records that every check of the project passed with its files as they were when `seen` was looked up, unless
   * an edit touched the project since: a change made while the checks ran keeps the project changed.
   */
  accept(projectDir: string, seen: ProjectChange): void
  /** Records that the agent changed a file of the project. */
  touch(projectDir: string): void
}

/** A source edited since its check last passed, relative to the directory of `interlint.yaml`, and the lines its edits wrote. */
export interface PendingEdit {
  file: string
  lines: number
}

/**
 * Remembers, for each `edit` check with `every` or `lines`, the sources edited since it last passed, across the
 * processes of consecutive edits. It is read and changed only under the project lock, so two edits in a row lose or
 * repeat none.
 */
export interface PendingEdits {
  /** The check's pending files: none when none were saved, and `undefined` when they were saved but cannot be read now. */
  list(projectDir: string, check: string): PendingEdit[] | undefined
  /** Replaces the check's pending files, and returns whether they were saved. */
  save(projectDir: string, check: string, edits: PendingEdit[]): boolean
}

export interface ProjectChange {
  changed: boolean
  /** What the tracker held for the project when it was looked up, so `accept` can tell an edit came since. */
  record: string | undefined
  /** The project's files when it was looked up, before its checks ran. */
  fingerprint: string
  /** When the project last changed, in milliseconds since the epoch: a report written later saw it as it is. */
  lastModifiedMs: number
}

export interface ReportResult {
  /** Whether the run wrote any report at all. */
  found: boolean
  failures: RuleFailure[]
  /**
   * Types the failures name without a package, present only when there are some. javac never compiles a class like
   * that, so the classes the report was made from are broken and its failures cannot be trusted.
   */
  typesWithoutPackage?: string[]
  /** The FreezingArchRule stores written from broken classes, present only when there are some. */
  brokenStores?: BrokenStore[]
  /**
   * Whether the command's output shows it also failed on more than the tests, such as a module that does not
   * compile. Present, as true, only then: the report cannot tell, so its failures alone do not explain the exit code.
   */
  otherFailure?: boolean
}

/**
 * A FreezingArchRule store whose frozen violations name types without a package: it was written while the classes
 * were broken. ArchUnit compares violations with the store as text, so once the classes are sound again those frozen
 * violations look new. They are the team's accepted debt, not the agent's to fix.
 */
export interface BrokenStore {
  /** The store directory, `/`-separated and relative to the project. */
  path: string
  typesWithoutPackage: string[]
  /** How many violations of the run were frozen in the store, and so left out of the failures. */
  hidden: number
}

/** Report files present before a run, with a fingerprint of each (modification time and size). */
export type ReportSnapshot = ReadonlyMap<string, string>

/** Reads what one run of a check left behind. */
export interface ReportReader {
  snapshot(projectDir: string): ReportSnapshot
  /** `output` is the end of the command's output, for reports that cannot say on their own why the command failed. */
  read(projectDir: string, before: ReportSnapshot, output: string): ReportResult
  /**
   * Reads the reports `command` writes from those a build already left, such as one the agent ran itself, when each
   * of them is there and was written after `sinceMs`; otherwise nothing. A report that also lists what the build
   * accepted gives all its findings as failures: without the build's exit code they cannot be told apart.
   */
  readFresh?(projectDir: string, command: string, sinceMs: number): ReportResult | undefined
  /**
   * Whether the report also lists what the build accepted, such as warnings under the project's threshold.
   * The exit code then decides: its failures count only when the command failed, and a zero exit passes even
   * without a report.
   */
  alsoListsAccepted?: boolean
}

/** One reader per report format a check can declare. */
export type ReportReaders = Record<Report, ReportReader>

/**
 * At edit, the command limited to the changed files, given relative to `dir`, the directory the check runs in, when
 * its tool can be told to check only some files. Otherwise the command as it is.
 */
export type EditScope = (command: string, files: string[], dir: string) => string
