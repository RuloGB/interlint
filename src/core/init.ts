import type { Check } from "./check.js"

/** What `interlint init` found in the project. */
export interface ProjectFacts {
  /** Simple names of the test classes with `@ArchTest`. */
  archTestClasses: string[]
  hasMavenWrapper: boolean
}

/** A class name made of letters, digits and `_` only. Anything else (`$`, `(`, `;`…) could mean something to the shell. */
const PLAIN_CLASS_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u

/**
 * The ArchUnit classes `-Dtest` will name, sorted. Surefire matches `-Dtest` by simple name, so two classes
 * with the same name appear once. A name that is not a plain class name is left out: it goes into a shell command.
 */
export function runnableClasses(facts: ProjectFacts): string[] {
  return [...new Set(facts.archTestClasses)].filter((name) => PLAIN_CLASS_NAME.test(name)).sort()
}

/**
 * The project's own Maven, as the whole team runs it. `interlint check` runs it with mvnd when mvnd
 * is on the PATH, so the versioned file stays the same on every machine.
 */
export function mavenCommand(facts: ProjectFacts): string {
  return facts.hasMavenWrapper ? "./mvnw" : "mvn"
}

/**
 * The check that runs only the ArchUnit test classes, or nothing when there are none.
 * Always `when: edit`: without mvnd it waits for task end anyway, so the file is the same on every machine.
 */
export function architectureCheck(facts: ProjectFacts): Check | undefined {
  const classes = runnableClasses(facts).join(",")
  if (classes === "") return undefined
  return {
    name: "architecture",
    run: `${mavenCommand(facts)} -q test -Dtest=${classes}`,
    report: "archunit",
    when: "edit",
  }
}
