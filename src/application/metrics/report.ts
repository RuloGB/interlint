import type { MetricsSummary, Tally } from "../../domain/metric-summary.js"
import { duration, plural, ratio, sum } from "./figures.js"

/** Values drawn as bars or as a line, one per label of their chart. */
export interface Series {
  name: string
  values: number[]
  as: "bar" | "line"
}

/** One group of bars per label. Several bar series are stacked. */
export interface BarChart {
  kind: "bar"
  title: string
  /** Bars along the vertical axis, for long labels such as rule names. */
  horizontal: boolean
  axis: string
  labels: string[]
  series: Series[]
}

/** Absolute shares: always shown beside a normalized bar chart, since a model used more has a larger share. */
export interface PieChart {
  kind: "pie"
  title: string
  slices: { label: string; value: number }[]
}

export type Chart = BarChart | PieChart

export interface ReportTable {
  headers: string[]
  rows: (string | number)[][]
}

export interface ReportSection {
  title: string
  /** Only charts with something to draw. */
  charts: Chart[]
  table: ReportTable
  note?: string
}

/** The metrics report, before it is written as Markdown or HTML. */
export interface Report {
  projects: string[]
  from: string | undefined
  to: string | undefined
  filters: string[]
  /** `YYYY-MM-DD`. */
  generated: string
  /** The figures a reader looks at first. */
  headline: { label: string; value: string }[]
  sections: ReportSection[]
  /** How many lines were not events, or an empty string. */
  notes: string
}

/** Rules drawn in the rules chart: more would not fit. The table keeps the top 20. */
const CHART_RULES = 10

const NORMALIZED =
  "Compare by violations per check run: a model used more has more violations. Sessions and checks run say how much is behind each figure."

export function reportOf(summary: MetricsSummary, notes: string, filters: string[], generated: Date): Report {
  const sessions = summary.sessions
  return {
    projects: summary.projects,
    from: summary.from,
    to: summary.to,
    filters,
    generated: generated.toISOString().slice(0, 10),
    headline: [
      { label: "Checks run", value: String(summary.checksRun) },
      { label: "Violations", value: String(summary.violations) },
      { label: "Task-end blocks fixed", value: `${summary.fixed} of ${summary.blocks}` },
    ],
    sections: [
      {
        title: "Totals",
        charts: [],
        table: {
          headers: ["Checks run", "Skipped", "Violations", "Sessions", "Task-end blocks", "Fixed", "Time spent on checks"],
          rows: [[summary.checksRun, summary.skipped, summary.violations, sessions.length, summary.blocks, summary.fixed, duration(summary.waitMs)]],
        },
        note: "A violation counts once in every run that shows it. Skipped checks are not counted as run.",
      },
      {
        title: "Violations by type",
        charts: drawable([
          bars("Violations by type", "Violations", summary.byType.map(({ type }) => type), [
            { name: "Violations", values: summary.byType.map(({ violations }) => violations), as: "bar" },
          ]),
        ]),
        table: { headers: ["Type", "Violations"], rows: summary.byType.map(({ type, violations }) => [type, violations]) },
      },
      {
        title: "Top 20 rules",
        charts: drawable([rulesChart(summary)]),
        table: {
          headers: ["Violations", "Type", "Rule"],
          rows: summary.rules.slice(0, 20).map(({ violations, type, rule }) => [violations, type, rule]),
        },
      },
      {
        title: "By model",
        charts: drawable([failedPie(summary), perCheck("Violations per check run by model", summary.byModel)]),
        table: tallyTable("Model", summary.byModel),
        note: NORMALIZED,
      },
      { title: "By agent", charts: [], table: tallyTable("Agent", summary.byAgent), note: NORMALIZED },
      {
        title: "Sessions",
        charts: [],
        table: {
          headers: ["Session", "Agent", "Model", "Checks run", "Violations", "Blocks", "Fixed", "Ended green"],
          rows: sessions.map((s) => [s.session, s.agent, s.model, s.checks, s.violations, s.blocks, s.fixed, green(s.endedGreen)]),
        },
        note:
          sessions.length === 0
            ? "No checks ran in an agent's session."
            : `${ratio(sum(sessions.map((s) => s.checks)), sessions.length, 1)} checks run per session on average, ${Math.max(...sessions.map((s) => s.checks))} at most.`,
      },
      {
        title: "Task-end blocks",
        charts: [],
        table: {
          headers: ["Model", "Blocks", "Fixed", "Fix rate"],
          rows: summary.blocksByModel.map(({ name, blocks, fixed }) => [name, blocks, fixed, `${Math.round((fixed / blocks) * 100)}%`]),
        },
        note: "A block is a task end in an agent's session where a check did not pass. It is fixed when a later task end of the same session passes.",
      },
      {
        title: "Time spent on checks",
        charts: drawable([timeChart(summary)]),
        table: {
          headers: ["Check", "Moment", "Runs", "Total", "Average"],
          rows: summary.waitByCheck.map(({ check, when, runs, totalMs }) => [check, when, runs, duration(totalMs), duration(totalMs / runs)]),
        },
      },
      {
        title: "Over time",
        charts: drawable([
          bars("Checks run (bars) and violations (line) per week", "Checks and violations", summary.byWeek.map(({ week }) => week), [
            { name: "Checks run", values: summary.byWeek.map(({ checks }) => checks), as: "bar" },
            { name: "Violations", values: summary.byWeek.map(({ violations }) => violations), as: "line" },
          ]),
        ]),
        table: {
          headers: ["Week of", "Checks run", "Violations"],
          rows: summary.byWeek.map(({ week, checks, violations }) => [week, checks, violations]),
        },
        note: "Weeks start on Monday, in UTC.",
      },
    ],
    notes,
  }
}

function bars(title: string, axis: string, labels: string[], series: Series[], horizontal = false): BarChart {
  return { kind: "bar", title, horizontal, axis, labels, series }
}

function rulesChart(summary: MetricsSummary): BarChart {
  const top = summary.rules.slice(0, CHART_RULES)
  return bars(
    `Top ${CHART_RULES} rules`,
    "Violations",
    top.map(({ rule }) => rule),
    [{ name: "Violations", values: top.map(({ violations }) => violations), as: "bar" }],
    true,
  )
}

/** Each slice says how many checks and sessions are behind it; models with no failed check have none. */
function failedPie(summary: MetricsSummary): PieChart {
  return {
    kind: "pie",
    title: "Failed checks by model",
    slices: summary.byModel.flatMap((tally) => {
      const failed = summary.failedByModel.find(({ name }) => name === tally.name)?.failed ?? 0
      return failed === 0 ? [] : [{ label: `${tally.name} (${plural(tally.checks, "check")}, ${plural(tally.sessions, "session")})`, value: failed }]
    }),
  }
}

function perCheck(title: string, tallies: Tally[]): BarChart {
  return bars(title, "Violations per check run", tallies.map(({ name }) => name), [
    {
      name: "Violations per check run",
      values: tallies.map(({ violations, checks }) => (checks === 0 ? 0 : Number((violations / checks).toFixed(2)))),
      as: "bar",
    },
  ])
}

/** Seconds per check, `edit` and `task-end` stacked. */
function timeChart(summary: MetricsSummary): BarChart {
  const checks = [...new Set(summary.waitByCheck.map(({ check }) => check))]
  const moments = [...new Set(summary.waitByCheck.map(({ when }) => when))].sort()
  return bars(
    "Time spent on checks (seconds)",
    "Seconds",
    checks,
    moments.map((when) => ({
      name: when,
      values: checks.map((check) => {
        const wait = summary.waitByCheck.find((entry) => entry.check === check && entry.when === when)
        return wait === undefined ? 0 : Number((wait.totalMs / 1000).toFixed(1))
      }),
      as: "bar",
    })),
  )
}

/** The charts with something to draw: no empty pie, no chart of zeros. */
function drawable(charts: Chart[]): Chart[] {
  return charts.filter((chart) =>
    chart.kind === "pie" ? chart.slices.length > 0 : chart.series.some((series) => series.values.some((value) => value > 0)),
  )
}

function tallyTable(label: string, tallies: Tally[]): ReportTable {
  return {
    headers: [label, "Sessions", "Checks run", "Violations", "Violations per check run"],
    rows: tallies.map((tally) => [tally.name, tally.sessions, tally.checks, tally.violations, ratio(tally.violations, tally.checks, 2)]),
  }
}

function green(ended: boolean | undefined): string {
  return ended === undefined ? "no task end" : ended ? "yes" : "no"
}
