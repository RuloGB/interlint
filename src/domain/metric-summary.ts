import type { MetricEvent } from "./metric.js"

/** What the checks of one model, or of one agent, gave. */
export interface Tally {
  /** `unknown` for a model the agent did not give, `manual` for checks run without an agent. */
  name: string
  /** Checks that ran: skipped checks do not count (decision 46). */
  checks: number
  violations: number
  /** Distinct agent sessions behind the figures. */
  sessions: number
}

export interface RuleTally {
  rule: string
  type: string
  violations: number
}

export interface SessionSummary {
  session: string
  agent: string
  /** The last model the session used, or `unknown`. */
  model: string
  /** When its first check ran. */
  start: string
  checks: number
  violations: number
  blocks: number
  fixed: number
  /** Whether its last task end passed; `undefined` when it never reached one. */
  endedGreen: boolean | undefined
}

export interface MetricsSummary {
  projects: string[]
  /** The first and last day with events, `YYYY-MM-DD` in UTC. */
  from: string | undefined
  to: string | undefined
  checksRun: number
  skipped: number
  /** Counted per run: a violation shown again in the next run counts again (decision 45). */
  violations: number
  byType: { type: string; violations: number }[]
  rules: RuleTally[]
  byModel: Tally[]
  byAgent: Tally[]
  sessions: SessionSummary[]
  blocks: number
  fixed: number
  blocksByModel: { name: string; blocks: number; fixed: number }[]
  waitMs: number
  waitByCheck: { check: string; when: string; runs: number; totalMs: number }[]
  byWeek: { week: string; checks: number; violations: number }[]
}

export const UNKNOWN_MODEL = "unknown"
export const NO_AGENT = "manual"

/** Sums up the metrics events, in the order they were written. Pure: the caller reads and filters them. */
export function summarize(events: MetricEvent[]): MetricsSummary {
  const ran = events.filter((event) => event.result !== "skipped")
  const days = events.map((event) => event.at.slice(0, 10)).sort()
  const runs = runsOf(events)
  const blocks = blocksOf(runs)
  return {
    projects: [...new Set(events.map((event) => event.project))].sort(),
    from: days[0],
    to: days.at(-1),
    checksRun: ran.length,
    skipped: events.length - ran.length,
    violations: sum(events, violationCount),
    byType: countBy(events.flatMap(typedViolations), (violation) => violation.type)
      .map(([type, violations]) => ({ type, violations })),
    rules: countBy(events.flatMap(typedViolations), (violation) => `${violation.type}\u0000${violation.rule}`)
      .map(([key, violations]) => {
        const [type = "", rule = ""] = key.split("\u0000")
        return { rule, type, violations }
      }),
    byModel: tallies(events, (event) => event.model ?? UNKNOWN_MODEL),
    byAgent: tallies(events, (event) => event.agent ?? NO_AGENT),
    sessions: sessionsOf(events, runs, blocks),
    blocks: blocks.length,
    fixed: blocks.filter((block) => block.fixed).length,
    blocksByModel: groupBy(blocks, (block) => block.model).map(([name, group]) => ({
      name,
      blocks: group.length,
      fixed: group.filter((block) => block.fixed).length,
    })),
    waitMs: sum(events, (event) => event.durationMs),
    waitByCheck: groupBy(ran, (event) => `${event.check}\u0000${event.when}`)
      .map(([key, group]) => {
        const [check = "", when = ""] = key.split("\u0000")
        return { check, when, runs: group.length, totalMs: sum(group, (event) => event.durationMs) }
      })
      .sort((a, b) => a.check.localeCompare(b.check) || a.when.localeCompare(b.when)),
    byWeek: groupBy(events, (event) => weekOf(event.at))
      .map(([week, group]) => ({
        week,
        checks: group.filter((event) => event.result !== "skipped").length,
        violations: sum(group, violationCount),
      }))
      .sort((a, b) => a.week.localeCompare(b.week)),
  }
}

/** The lines one `interlint check` process wrote: they share their moment and project. */
interface Run {
  events: MetricEvent[]
  at: string
  when: string
  session: string | undefined
  agent: string | undefined
  model: string
  passed: boolean
}

interface Block {
  run: Run
  model: string
  fixed: boolean
}

function runsOf(events: MetricEvent[]): Run[] {
  return groupBy(events, (event) => `${event.projectKey}\u0000${event.at}`)
    .map(([, group]) => {
      const [first] = group as [MetricEvent]
      return {
        events: group,
        at: first.at,
        when: first.when,
        session: first.session,
        agent: first.agent,
        model: group.find((event) => event.model !== undefined)?.model ?? UNKNOWN_MODEL,
        passed: group.every((event) => event.result === "passed" || event.result === "skipped"),
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * The task ends a check stopped: a task-end run of an agent's session where a check did not pass. It is fixed when a
 * later task-end run of the same session passes (decision 47). Runs by hand have no session, so they block nothing.
 */
function blocksOf(runs: Run[]): Block[] {
  const blocks: Block[] = []
  const passedLater = new Set<string>()
  for (const run of [...runs].reverse()) {
    if (run.when !== "task-end" || run.agent === undefined || run.session === undefined) continue
    if (run.passed) passedLater.add(run.session)
    else blocks.push({ run, model: run.model, fixed: passedLater.has(run.session) })
  }
  return blocks.reverse()
}

function sessionsOf(events: MetricEvent[], runs: Run[], blocks: Block[]): SessionSummary[] {
  const withSession = events.filter((event) => event.session !== undefined)
  return groupBy(withSession, (event) => event.session as string).map(([session, group]) => {
    const [first] = group as [MetricEvent]
    const ownBlocks = blocks.filter((block) => block.run.session === session)
    const lastTaskEnd = runs.filter((run) => run.session === session && run.when === "task-end").at(-1)
    return {
      session,
      agent: first.agent ?? NO_AGENT,
      model: group.findLast((event) => event.model !== undefined)?.model ?? UNKNOWN_MODEL,
      start: first.at,
      checks: group.filter((event) => event.result !== "skipped").length,
      violations: sum(group, violationCount),
      blocks: ownBlocks.length,
      fixed: ownBlocks.filter((block) => block.fixed).length,
      endedGreen: lastTaskEnd?.passed,
    }
  })
}

function tallies(events: MetricEvent[], nameOf: (event: MetricEvent) => string): Tally[] {
  return groupBy(events, nameOf)
    .map(([name, group]) => ({
      name,
      checks: group.filter((event) => event.result !== "skipped").length,
      violations: sum(group, violationCount),
      sessions: new Set(group.flatMap((event) => (event.session === undefined ? [] : [event.session]))).size,
    }))
    .sort((a, b) => b.checks - a.checks || a.name.localeCompare(b.name))
}

/** Each violation with its type; one without takes its check's report: ArchUnit's are architecture rules. */
function typedViolations(event: MetricEvent): { rule: string; type: string }[] {
  return (event.violations ?? []).map((violation) => ({
    rule: violation.rule,
    type: violation.type ?? (event.report === "archunit" ? "architecture" : "other"),
  }))
}

function violationCount(event: MetricEvent): number {
  return event.violations?.length ?? 0
}

/** The Monday of the moment's week, `YYYY-MM-DD` in UTC. */
function weekOf(at: string): string {
  const day = new Date(at)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

/** Items grouped by key, in the order each key first appears. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [item])
    else group.push(item)
  }
  return [...groups]
}

/** How many items share each key, most first, ties in the order they first appear. */
function countBy<T>(items: T[], keyOf: (item: T) => string): [string, number][] {
  return groupBy(items, keyOf)
    .map(([key, group]): [string, number] => [key, group.length])
    .sort((a, b) => b[1] - a[1])
}

function sum<T>(items: T[], valueOf: (item: T) => number): number {
  return items.reduce((total, item) => total + valueOf(item), 0)
}
