import type { Check } from "./check.js"

/** What `interlint init` found in the project. */
export interface ProjectFacts {
  /** Simple names of the test classes with `@ArchTest`. */
  archTestClasses: string[]
  hasMavenWrapper: boolean
}

/** The project's own Maven, as the whole team runs it. Interlint switches it to mvnd at run time (decision 16). */
export function mavenCommand(facts: ProjectFacts): string {
  return facts.hasMavenWrapper ? "./mvnw" : "mvn"
}

/**
 * The check that runs only the ArchUnit test classes, or nothing when there are none.
 * Always `when: edit`: without mvnd it waits for task end anyway, so the file is the same on every machine.
 */
export function architectureCheck(facts: ProjectFacts): Check | undefined {
  if (facts.archTestClasses.length === 0) return undefined
  // Surefire matches `-Dtest` by simple name, so two classes with the same name need it once.
  const classes = [...new Set(facts.archTestClasses)].sort().join(",")
  return {
    name: "architecture",
    run: `${mavenCommand(facts)} -q test -Dtest=${classes}`,
    report: "archunit",
    when: "edit",
  }
}
