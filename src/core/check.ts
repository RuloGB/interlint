export const REPORTS = ["archunit"] as const
export const WHENS = ["edit", "task-end"] as const

export type Report = (typeof REPORTS)[number]
export type When = (typeof WHENS)[number]

export interface Check {
  name: string
  run: string
  report: Report
  when: When
}

export interface Config {
  checks: Check[]
}
