import { type Check, NO_RESULT, REPORT_TOOLS } from "../../domain/check.js"
import { usesMaven } from "../../domain/maven-command.js"
import type { Violation } from "../../domain/violation.js"
import type { CheckOutcome } from "./run-checks.js"

const MAX_VIOLATIONS_PER_RULE = 10
const MAX_TYPES_SHOWN = 3
const FOOTER = "Fix these problems before continuing."

/** Formats the outcomes for the agent. Returns an empty string when every check passed. */
export function formatOutcomes(outcomes: CheckOutcome[]): string {
  const blocks = outcomes.flatMap((outcome) => {
    if (outcome.status === "violations") {
      const failures = outcome.failures.map((failure) =>
        [`✗ ${outcome.check.name} · ${failure.title}`, "", ...violationLines(failure.violations)].join("\n"),
      )
      return outcome.check.report === "jacoco" ? [...failures, coverageHint(outcome.check)] : failures
    }
    if (outcome.status === "missing-dir") {
      return [
        [
          `✗ ${outcome.check.name} · its dir "${outcome.check.dir}" does not exist`,
          "",
          "  Fix dir in interlint.yaml, or remove the check if the project is gone.",
        ].join("\n"),
      ]
    }
    if (outcome.status === "broken-build") {
      const tool = REPORT_TOOLS[outcome.check.report]
      return [
        [
          `✗ ${outcome.check.name} · the compiled classes are broken, so its ${tool} violations are not shown`,
          "",
          `  The report names types without a package: ${typeList(outcome.typesWithoutPackage)}.`,
          "  javac never compiles a class like that. An IDE building automatically wrote to target/ while the check",
          "  ran. Do not change the code for these violations: check again.",
        ].join("\n"),
      ]
    }
    if (outcome.status === "failed") {
      const tool = REPORT_TOOLS[outcome.check.report]
      return [
        [
          outcome.exitCode === 0
            ? `✗ ${outcome.check.name} · the command exited 0 but ${NO_RESULT[outcome.check.report]}`
            : `✗ ${outcome.check.name} · the command failed (exit code ${outcome.exitCode}) and left no ${tool} failures`,
          "",
          `  Command: ${outcome.command}`,
          "  Last lines of its output:",
          ...outcome.outputTail.split("\n").map((line) => `    ${line}`),
        ].join("\n"),
      ]
    }
    return []
  })

  return blocks.length === 0 ? "" : `${[...blocks, FOOTER].join("\n\n")}\n`
}

/**
 * Formats, in one line, the checks that ran and passed, so the user sees Interlint at work. Returns an empty string
 * when no check ran or one did not pass: the failures say it then.
 */
export function formatPassed(outcomes: CheckOutcome[]): string {
  if (outcomes.length === 0 || outcomes.some((outcome) => outcome.status !== "passed")) return ""
  const checks = outcomes.map((outcome) => {
    const took = outcome.status === "passed" && outcome.fromBuild ? "in the last build" : `${(outcome.durationMs / 1000).toFixed(1)}s`
    return `${outcome.check.name} (${took})`
  })
  return `✓ Interlint · checks passed: ${checks.join(", ")}\n`
}

/**
 * Formats what the user, not the agent, has to do: refreeze each FreezingArchRule store written from broken classes.
 * Returns an empty string when there is nothing. The agent may still read it, so it says what the agent should do.
 */
export function formatNotices(outcomes: CheckOutcome[]): string {
  const seen = new Set<string>()
  const blocks = outcomes.flatMap(({ check, brokenStores = [] }) =>
    brokenStores
      .filter(({ path }) => {
        if (seen.has(path)) return false
        seen.add(path)
        return true
      })
      .map((store) =>
        [
          `ℹ Interlint · for the user: the ArchUnit store ${store.path} was frozen from broken compiled classes`,
          "",
          `  It names types without a package: ${typeList(store.typesWithoutPackage)}. Its frozen violations no longer match`,
          `  the code, so ArchUnit reports them as new. ${hiddenLine(store.hidden)}`,
          `  Refreeze it from a clean build${check.dir === undefined ? "" : `, in ${check.dir}`}: ${mavenOf(check.run)} clean test -D${REFREEZE}`,
          "  Agent: do not change the code for this. Tell the user.",
        ].join("\n"),
      ),
  )
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`
}

const REFREEZE = "archunit.freeze.refreeze=true"

/**
 * Where the agent finds what a coverage rule leaves uncovered. A rule on a bundle or a package names no class, and
 * JaCoCo's CSV report gives the missed lines and branches of each class.
 */
function coverageHint(check: Check): string {
  return `  To see which classes lack tests, run ${mavenOf(check.run)} jacoco:report and read target/site/jacoco/jacoco.csv in each module.`
}

function hiddenLine(hidden: number): string {
  return hidden === 0 ? "None of them came up in this run." : `Interlint did not show the agent ${hidden} of them.`
}

/** The Maven executable the check runs, so the user refreezes with the team's own Maven. */
function mavenOf(run: string): string {
  const executable = run.trimStart().split(/\s+/)[0] ?? ""
  return usesMaven(executable) ? executable : "mvn"
}

function typeList(types: string[]): string {
  const shown = types.slice(0, MAX_TYPES_SHOWN).map((type) => `<${type}>`).join(", ")
  const hidden = types.length - MAX_TYPES_SHOWN
  return hidden > 0 ? `${shown} and ${hidden} more` : shown
}

function violationLines(violations: Violation[]): string[] {
  const shown = violations.slice(0, MAX_VIOLATIONS_PER_RULE).flatMap((violation) => {
    const lines = [`  ${violation.text}`]
    if (violation.path) lines.push(`    at ${violation.path}${violation.line ? `:${violation.line}` : ""}`)
    return lines
  })
  const hidden = violations.length - MAX_VIOLATIONS_PER_RULE
  return hidden > 0 ? [...shown, `  … and ${hidden} more`] : shown
}
