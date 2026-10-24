import type { CheckOutcome } from "../check/run-checks.js"
import type { Violation } from "../report/report.js"

const MAX_VIOLATIONS_PER_RULE = 10
const FOOTER = "Fix these problems before continuing."

/** Formats the outcomes for the agent. Returns an empty string when every check passed. */
export function formatOutcomes(outcomes: CheckOutcome[]): string {
  const blocks = outcomes.flatMap((outcome) => {
    if (outcome.status === "violations") {
      return outcome.failures.map((failure) =>
        [`✗ ${outcome.check.name} · ${failure.title}`, "", ...violationLines(failure.violations)].join("\n"),
      )
    }
    if (outcome.status === "failed") {
      return [
        [
          `✗ ${outcome.check.name} · the command failed (exit code ${outcome.exitCode}) and left no ArchUnit failures`,
          "",
          `  Command: ${outcome.check.run}`,
          "  Last lines of its output:",
          ...outcome.outputTail.split("\n").map((line) => `    ${line}`),
        ].join("\n"),
      ]
    }
    return []
  })

  return blocks.length === 0 ? "" : `${[...blocks, FOOTER].join("\n\n")}\n`
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
