import type { MetricEvent } from "../../domain/metric.js"

/** Whose metrics to read: one project, by its directory, or every project of the user. */
export type MetricsScope = { projectDir: string } | { all: true }

export interface MetricsRead {
  /** In the order they were written. */
  events: MetricEvent[]
  /** Lines that are not events, such as lines edited by hand. They are left out. */
  unreadable: number
}

/** Reads the metrics `interlint check` kept. */
export interface MetricsSource {
  /** Nothing, and no error, when there are none. */
  read(scope: MetricsScope): MetricsRead
  /** Where the metrics of the scope are kept, to tell the user. */
  location(scope: MetricsScope): string
}

/** The file a report is written to. */
export interface ReportFile {
  exists(path: string): boolean
  write(path: string, content: string): void
}
