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
