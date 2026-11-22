/** A build the agent runs itself in a shell, which must not share `target/` with Interlint's checks. */

/**
 * Maven, the Maven Wrapper or the Maven Daemon run anywhere in a shell command line, with an optional path, `.cmd` or
 * `.bat`, such as `mvn test`, `cd api && ./mvnw verify` or `& .\mvnw.cmd test`.
 */
const MAVEN_IN_SHELL = /(?:^|[\s;&|()`"'])(?:[^\s;&|()`"']*[\\/])?(?:mvn|mvnw|mvnd)(?:\.cmd|\.bat)?(?=$|[\s;&|()`"'])/i

/**
 * A Maven goal that starts a server and runs until it is stopped, such as `spring-boot:run`, `quarkus:dev` or
 * `jetty:run`. Holding the project lock while it runs would stop every check for good.
 */
const SERVER_GOAL = /(?:^|\s)[\w.-]+:(?:run|dev)(?=$|[\s;&|)])/i

/** A build that waited this long for the checks says so, as its output would not say why it took long. */
export const LOCK_WAIT_NOTE_MS = 1000

/**
 * A command line that only runs Maven, with at most a `cd` before it, such as `mvn test`, `./mvnw -q verify -pl api`,
 * `& .\mvnw.cmd test` or `cd orders && ./mvnw test`. No character that could start another command, redirect output or
 * substitute one may appear: `;`, `&`, `|`, backticks, `$`, `<`, `>`, parentheses, braces or a line break, except the
 * `&&` or `;` after the `cd`.
 */
const ONLY_MAVEN = new RegExp(
  String.raw`^\s*(?:cd\s+[^;&|\x60$<>(){}\r\n]+?\s*(?:&&|;)\s*)?(?:&\s+)?(?:[^\s;&|\x60$<>(){}\r\n]*[\\/])?(?:mvn|mvnw|mvnd)(?:\.cmd|\.bat)?(?:\s+[^;&|\x60$<>(){}\r\n]*)?$`,
  "i",
)

/** Whether a shell command line runs Maven. */
export function runsMaven(command: string): boolean {
  return MAVEN_IN_SHELL.test(command)
}

/**
 * Whether a command line only runs Maven, so it can be wrapped without hiding anything from Copilot's shell permission
 * rules: inside the wrapped command, another command would be in base64, where a rule could not read it.
 */
export function onlyMaven(command: string): boolean {
  return ONLY_MAVEN.test(command)
}

/** Whether a shell command line starts a server that runs until it is stopped. */
export function startsServer(command: string): boolean {
  return SERVER_GOAL.test(command)
}

/** What a build that waited for Interlint's checks tells the agent before its own output. */
export function lockWaitNote(waitedMs: number): string {
  return `Interlint: this command waited ${Math.round(waitedMs / 1000)} s for Interlint's checks on this project to finish, so the two builds did not share target/.`
}
