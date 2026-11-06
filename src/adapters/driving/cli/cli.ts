import type { CheckProjectDeps } from "../../../application/checking/check-project.js"
import type { FeedbackDeps } from "../../../application/feedback/agent-events.js"
import type { MetricsDeps } from "../../../application/metrics/show-metrics.js"
import type { InitDeps } from "../../../application/setup/init-project.js"
import { hook } from "../claude-code/hook-command.js"
import { check } from "./check-command.js"
import { EXIT, type Io, reportError, UsageError } from "./cli-io.js"
import { init } from "./init-command.js"
import { metrics } from "./metrics-command.js"

const USAGE = `Usage:
  interlint --version                                          Print the installed version of Interlint
  interlint init [--agent opencode|claude-code] [--force] [--cwd <dir>]
                                                               Detect the project's checks and write interlint.yaml
  interlint check [--when task-end] [--changed] [--file <path>...] [--cwd <dir>]
                                                               Run every check in interlint.yaml
  interlint check --when edit --file <path>... [--cwd <dir>]   Run the edit checks for the changed files
  interlint hook claude-code post-edit|stop|subagent-stop      Claude Code hook: reads the hook's JSON on stdin
  interlint metrics [--all] [--since <YYYY-MM-DD>] [--agent claude-code|opencode] [--cwd <dir>]
                                                               Sum up the metrics of the checks
  interlint metrics report [--out <path>] [--force] [same options as metrics]
                                                               Write the full metrics report in Markdown

A check with dir runs in that directory (one Maven project of a workspace). An edit check runs
only when a changed file inside its project is one of its sources (*.java for report: archunit
and maven). With mvnd on the PATH, a check whose run starts with mvn, mvnw or ./mvnw runs with
mvnd instead; without mvnd, Maven edit checks wait for task-end.

--changed runs only the checks of the projects that changed since their checks last passed:
a file changed, or an edit check named one of its files. The agent integrations use it.
With --changed, a check passes without running when a build since the last change, such as
mvn verify run by the agent, left all the reports it writes and they list no failure. At task end, --file runs only the checks of the projects that hold one of those files: the agent
integrations pass the files a subagent changed, so it gets the failures of its own projects.

init writes an architecture check that runs the test classes with @ArchTest, with the Maven
Wrapper (or mvn), when: edit and every: 3, and a checkstyle check (report: maven, when: edit) and a
pmd check (report: maven, when: edit, every: 3) for the plugins in the build of pom.xml and its modules. In a directory without pom.xml it writes
the checks of each Maven project below it, with their dir. It never replaces a different
interlint.yaml without --force: without --agent it writes nothing, and with --agent it keeps that
file and still writes the agent's files.

A report: maven check fails only when Maven fails, and shows the most severe level in the
Checkstyle and PMD reports, so nothing the project's build accepts is shown. At edit it shows
only the failures of the changed files, and a run with checkstyle:check gets
-Dcheckstyle.includes so Checkstyle checks only those files; PMD checks the whole project.
--agent opencode copies the plugin to .opencode/plugins/interlint/; --agent claude-code adds
the post-edit, stop and subagent-stop hooks to .claude/settings.json and keeps the rest of the file.

Every check that runs or is skipped keeps one metrics line, with no code or message, in the
user's state directory (interlint/metrics under %LOCALAPPDATA% on Windows, $XDG_STATE_HOME or
~/.local/state elsewhere). metrics: false in interlint.yaml keeps none.

interlint metrics sums up the metrics of the project in --cwd (or the current directory), or of
every project with --all: checks run, violations by type, the top rules, violations per check run
by model and by agent, sessions, task-end blocks and time spent on checks. A violation counts in
every run that shows it. --since keeps the events from that day on (UTC) and --agent those of one
agent. metrics report writes all of it, with tables, to interlint-metrics.md in the project, or
to --out; it never replaces an existing file without --force.

Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.

A Claude Code hook exits as Claude Code expects instead: 0 nothing to report, 2 a check failed
(the failures go to the agent on stderr), 1 Interlint could not run (shown to the user, never a
block). stop blocks at most 3 times in a row, then lets the task end and shows the failures.
subagent-stop checks only the projects of the files that subagent changed, and runs nothing for
a subagent that changed none; after 3 blocks it lets the subagent stop, and stop gets the rest.
`

/** The use cases the commands run, with their adapters. */
export interface CliDeps {
  checking: CheckProjectDeps
  feedback: FeedbackDeps
  setup: InitDeps
  metrics: MetricsDeps
  /** The installed version of Interlint. */
  version: () => string
}

export async function runCli(args: string[], io: Io, deps: CliDeps): Promise<number> {
  try {
    const [command, ...rest] = args
    if (command === undefined || command === "--help" || command === "-h") {
      io.stdout(USAGE)
      return EXIT.passed
    }
    if (command === "--version" || command === "-v") {
      io.stdout(`${deps.version()}\n`)
      return EXIT.passed
    }
    if (command === "check") return await check(rest, io, deps.checking)
    if (command === "init") return init(rest, io, deps.setup)
    if (command === "hook") return await hook(rest, io, deps.feedback)
    if (command === "metrics") return metrics(rest, io, deps.metrics)
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  } catch (error) {
    reportError(error, io)
    return EXIT.error
  }
}
