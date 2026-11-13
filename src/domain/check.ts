export const REPORTS = ["archunit", "maven", "jacoco", "eslint", "depcruise"] as const
export const WHENS = ["edit", "task-end"] as const

export type Report = (typeof REPORTS)[number]
export type When = (typeof WHENS)[number]

/** The TypeScript and JavaScript files. */
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/**
 * The files whose change makes an `edit` check worth running, by report format. Coverage needs the whole test suite
 * and is measured for a whole module, so no edit runs a JaCoCo check. ESLint's are a fixed list (decision 53): with
 * its older configuration format, ESLint checks any file it is given, whatever it is.
 */
const SOURCE_EXTENSIONS: Record<Report, readonly string[]> = {
  archunit: [".java"],
  maven: [".java"],
  jacoco: [],
  eslint: SCRIPT_EXTENSIONS,
  depcruise: SCRIPT_EXTENSIONS,
}

/** The report formats a check may use only at task end, with the reason `interlint.yaml` gives for it. */
export const TASK_END_ONLY: Partial<Record<Report, string>> = { jacoco: "coverage needs the whole test suite" }

/** The tools behind each report format, as the output names them. */
export const REPORT_TOOLS: Record<Report, string> = {
  archunit: "ArchUnit",
  maven: "Checkstyle, PMD or SpotBugs",
  jacoco: "JaCoCo",
  eslint: "ESLint",
  depcruise: "dependency-cruiser",
}

/** What a run that exits 0 without a result of its tool did not do, as the output says it. */
export const NO_RESULT: Record<Report, string> = {
  archunit: "wrote no ArchUnit report",
  maven: "wrote no Checkstyle, PMD or SpotBugs report",
  jacoco: "JaCoCo checked no coverage rule",
  eslint: "wrote no ESLint report",
  depcruise: "dependency-cruiser analyzed no source: it found no module, or no TypeScript compiler it supports",
}

/**
 * Whether an `edit` check shows only the failures of the changed files. Checkstyle, PMD and ESLint rate each file on
 * its own, so another file's failures are not the edit's, and task end reports them. An ArchUnit rule is about how
 * classes relate, so an edit can break it in a class the edit did not change. dependency-cruiser gives each violation
 * at the file that holds the import, so an edit's are in the files it changed.
 */
export const EDIT_SHOWS_CHANGED_FILES_ONLY: Record<Report, boolean> = {
  archunit: false,
  maven: true,
  jacoco: false,
  eslint: true,
  depcruise: true,
}

/** Whether `file`, relative to the project, is a source the check verifies. */
export function isSourceOf(report: Report, file: string): boolean {
  const lower = file.toLowerCase()
  return SOURCE_EXTENSIONS[report].some((extension) => lower.endsWith(extension))
}

export interface Check {
  name: string
  run: string
  report: Report
  when: When
  /**
   * The project the check runs in: a `/`-separated directory relative to `interlint.yaml`, such as one Maven
   * project of a workspace. Absent, the check runs where `interlint.yaml` is.
   */
  dir?: string
  /**
   * At edit, how many distinct sources of the check must be edited before it runs, on all of them. Absent, it runs
   * on every edit, as with 1, unless it has `lines`. It has no effect at task end.
   */
  every?: number
  /**
   * At edit, how many lines the edits of its sources must write before it runs, on all of them. With `every` too,
   * it runs on whichever comes first. It has no effect at task end.
   */
  lines?: number
}

/** Whether an `edit` check waits for its edits to add up to `every` or `lines`, instead of running on each one. */
export function waitsForEdits(check: Check): boolean {
  return check.lines !== undefined || (check.every ?? 1) > 1
}

/**
 * Whether the edits pending for a check that waits are enough to run it: `every` distinct sources, or `lines` lines
 * written in them, whichever comes first.
 */
export function editsAreDue(check: Check, sources: number, lines: number): boolean {
  return (check.every !== undefined && sources >= check.every) || (check.lines !== undefined && lines >= check.lines)
}

/** Whether `file`, relative to the directory of `interlint.yaml` and `/`-separated, is inside the check's project. */
export function isInProjectOf(check: Check, file: string): boolean {
  return check.dir === undefined || file.startsWith(`${check.dir}/`)
}

/** `path`, relative to the check's project, as a path relative to the directory of `interlint.yaml`. */
export function fromRoot(check: Check, path: string): string {
  return check.dir === undefined ? path : `${check.dir}/${path}`
}

export interface Config {
  checks: Check[]
  /** `false` keeps no metrics of the runs. Absent, they are kept (decision 42). */
  metrics?: boolean
}
