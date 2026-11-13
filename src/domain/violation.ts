export interface Violation {
  /** The violation as the check tool wrote it. */
  text: string
  className?: string
  file?: string
  line?: number
  /** Source path relative to the project root, when the file was found. */
  path?: string
  /**
   * Other source paths, relative to the project root, the violation also involves, such as the other modules of a
   * cycle. An edit of one of them shows the violation too.
   */
  related?: string[]
}

/** The kind of rule, by the tool that checks it. */
export type RuleType = "architecture" | "checkstyle" | "pmd" | "spotbugs" | "coverage" | "eslint"

export interface RuleFailure {
  /** The rule as the team wrote it, with its ID when it has one. */
  title: string
  /** Set by the reader that read the rule, for the metrics. */
  type?: RuleType
  violations: Violation[]
}
