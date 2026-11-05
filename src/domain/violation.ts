export interface Violation {
  /** The violation as the check tool wrote it. */
  text: string
  className?: string
  file?: string
  line?: number
  /** Source path relative to the project root, when the file was found. */
  path?: string
}

/** The kind of rule, by the tool that checks it. */
export type RuleType = "architecture" | "checkstyle" | "pmd"

export interface RuleFailure {
  /** The rule as the team wrote it, with its ID when it has one. */
  title: string
  /** Set by the reader that read the rule, for the metrics. */
  type?: RuleType
  violations: Violation[]
}
