import type { ProjectFacts } from "./project-facts.js"

/** The Maven Daemon. With it a Maven check is fast enough to run after every edit (decision 12). */
export const MAVEN_DAEMON = "mvnd"

/** A command whose first word is Maven, the Maven Wrapper or the Maven Daemon, with an optional `./` or `.\` and `.cmd`. */
const MAVEN_EXECUTABLE = /^(?:\.[\\/])?(?:mvn|mvnw|mvnd)(?:\.cmd)?(?=\s|$)/

export function usesMaven(command: string): boolean {
  return MAVEN_EXECUTABLE.test(command.trimStart())
}

/** Runs a Maven command with the daemon. Only the executable changes: the arguments stay as the team wrote them. */
export function withMavenDaemon(command: string): string {
  return command.trimStart().replace(MAVEN_EXECUTABLE, MAVEN_DAEMON)
}

/**
 * The project's own Maven, as the whole team runs it. `interlint check` runs it with mvnd when mvnd
 * is on the PATH, so the versioned file stays the same on every machine.
 */
export function mavenCommand(facts: ProjectFacts): string {
  return facts.hasMavenWrapper ? "./mvnw" : "mvn"
}
