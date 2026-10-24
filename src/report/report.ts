export interface Violation {
  /** The violation as the check tool wrote it. */
  text: string
  className?: string
  file?: string
  line?: number
  /** Source path relative to the project root, when the file was found. */
  path?: string
}

export interface RuleFailure {
  /** The rule as the team wrote it, with its ID when it has one. */
  title: string
  violations: Violation[]
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
  read(projectDir: string, before: ReportSnapshot): ReportResult
}
