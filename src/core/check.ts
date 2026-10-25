export const REPORTS = ["archunit", "maven"] as const
export const WHENS = ["edit", "task-end"] as const

export type Report = (typeof REPORTS)[number]
export type When = (typeof WHENS)[number]

/** The files whose change makes an `edit` check worth running, by report format. */
const SOURCE_EXTENSIONS: Record<Report, readonly string[]> = { archunit: [".java"], maven: [".java"] }

/** The tools behind each report format, as the output names them. */
export const REPORT_TOOLS: Record<Report, string> = { archunit: "ArchUnit", maven: "Checkstyle or PMD" }

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
}

export interface Config {
  checks: Check[]
}
