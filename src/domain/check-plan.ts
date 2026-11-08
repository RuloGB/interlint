import type { Check } from "./check.js"
import { mavenCommand } from "./maven-command.js"
import { type ProjectFacts, QUALITY_PLUGINS, type QualityPlugin, runnableClasses } from "./project-facts.js"

/**
 * PMD resolves types from the compiled classes, so its check compiles first. Compiling runs the lifecycle, and a
 * build may bind `checkstyle:check` to an early phase such as `validate`: skipping Checkstyle there keeps a
 * Checkstyle failure out of the `pmd` check, which the `checkstyle` check already reports. Checkstyle reads only
 * the sources and runs no lifecycle.
 */
const QUALITY_COMMANDS: Record<QualityPlugin, (goal: string) => string> = {
  checkstyle: (goal) => goal,
  pmd: (goal) => `compile ${goal} -Dcheckstyle.skip`,
}

/**
 * How many edited files a slow check waits for (decision 30). PMD analyses every module and ArchUnit builds the
 * project, which in a large reactor takes tens of seconds, too slow for every edit. Teams can change `every` in
 * `interlint.yaml`.
 */
export const SLOW_CHECK_EVERY = 5

/**
 * How many written lines a slow check waits for, if it reaches them before `SLOW_CHECK_EVERY` files: a few small
 * edits, such as a log line in three files, wait for task end, while a new class runs the check at once.
 */
export const SLOW_CHECK_LINES = 100

/** The `every` of each quality check: Checkstyle checks only the changed files, in under a second, so it has none. */
export const QUALITY_EVERY: Record<QualityPlugin, number | undefined> = { checkstyle: undefined, pmd: SLOW_CHECK_EVERY }

/** Every check `init` writes runs after edits; `every` and `lines`, when there is an `every`, space the slow ones out. */
function afterEdits(every: number | undefined): Pick<Check, "when" | "every" | "lines"> {
  return every === undefined ? { when: "edit" } : { when: "edit", every, lines: SLOW_CHECK_LINES }
}

/** An execution id made of letters, digits, `_`, `.` and `-` only. Anything else could mean something to the shell. */
const PLAIN_EXECUTION_ID = /^[\w.-]+$/

/**
 * The plugin's `check` goal as the build runs it. Maven applies the configuration inside an `<execution>` only when
 * the goal names that execution (`checkstyle:check@id`); called plainly, it runs with the plugin's defaults.
 */
function checkGoal(facts: ProjectFacts, plugin: QualityPlugin): string {
  const ids = facts.checkExecutions[plugin].filter((id) => PLAIN_EXECUTION_ID.test(id))
  return ids.length === 0 ? `${plugin}:check` : ids.map((id) => `${plugin}:check@${id}`).join(" ")
}

/** A module path made of letters, digits, `_`, `.`, `-` and `/` only. Anything else could mean something to the shell. */
const PLAIN_MODULE_PATH = /^[\w.\-/]+$/

/**
 * In a reactor, `-Dtest` reaches every module, and Surefire fails in a module without those classes unless told
 * not to. When the classes live in modules other than the root, `-pl <modules> -am` builds only those modules and
 * the ones they depend on, instead of the whole reactor.
 */
function reactorArgs(facts: ProjectFacts): string {
  if (!facts.hasModules) return ""
  const modules = facts.archTestModules
  const onlyModules = modules.length > 0 && modules.every((module) => module !== "" && PLAIN_MODULE_PATH.test(module))
  return onlyModules ? ` -pl ${[...modules].sort().join(",")} -am` : ""
}

/** Skips the Checkstyle and PMD plugins the build declares, for a check that runs the lifecycle for something else. */
function qualitySkips(facts: ProjectFacts): string {
  return QUALITY_PLUGINS.filter((plugin) => facts.qualityPlugins.includes(plugin))
    .map((plugin) => ` -D${plugin}.skip`)
    .join("")
}

/**
 * The check that runs only the ArchUnit test classes, or nothing when there are none. It builds the project, so it
 * runs after every `SLOW_CHECK_EVERY` edited files or `SLOW_CHECK_LINES` written lines.
 * `test` runs the lifecycle, so it skips the Checkstyle and PMD plugins the build declares: bound to an early
 * phase, their failure would stop the build before ArchUnit runs, and their own checks already report it.
 */
export function architectureCheck(facts: ProjectFacts): Check | undefined {
  const classes = runnableClasses(facts).join(",")
  if (classes === "") return undefined
  const reactor = facts.hasModules ? " -Dsurefire.failIfNoSpecifiedTests=false" : ""
  return {
    name: "architecture",
    run: `${mavenCommand(facts)} -q test${reactorArgs(facts)} -Dtest=${classes}${reactor}${qualitySkips(facts)}`,
    report: "archunit",
    ...afterEdits(SLOW_CHECK_EVERY),
  }
}

/**
 * One check per Checkstyle or PMD plugin the build declares. Each runs its own goal: in one Maven call the
 * first failing goal stops the rest. Each runs after edits, as often as `QUALITY_EVERY` says; the file is the same
 * with or without mvnd, since without it an `edit` check waits for task end anyway.
 */
export function qualityChecks(facts: ProjectFacts): Check[] {
  return QUALITY_PLUGINS.filter((plugin) => facts.qualityPlugins.includes(plugin)).map((plugin) => ({
    name: plugin,
    run: `${mavenCommand(facts)} -q ${QUALITY_COMMANDS[plugin](checkGoal(facts, plugin))}`,
    report: "maven",
    ...afterEdits(QUALITY_EVERY[plugin]),
  }))
}

/**
 * The check of the build's JaCoCo coverage rules, or nothing when no execution runs `jacoco:check`. It runs the
 * whole test suite, so only at task end, and names the execution so its rules apply; `test` stops before `verify`,
 * where the build runs that execution again.
 * - Without `-q`: Maven hides the broken rules with it, and prints only that coverage checks have not been met.
 * - `-fae` gives the broken rules of every module that can be built, not only of the first one.
 * - `-Djacoco.append=false` drops the coverage of earlier runs, such as that of tests deleted since.
 * - The Checkstyle and PMD plugins are skipped, as in the architecture check: their own checks report them.
 */
export function coverageCheck(facts: ProjectFacts): Check | undefined {
  const ids = facts.coverageExecutions.filter((id) => PLAIN_EXECUTION_ID.test(id))
  if (ids.length === 0) return undefined
  const goals = ids.map((id) => `jacoco:check@${id}`).join(" ")
  return {
    name: "coverage",
    run: `${mavenCommand(facts)} test ${goals} -fae -Djacoco.append=false${qualitySkips(facts)}`,
    report: "jacoco",
    when: "task-end",
  }
}

/**
 * Every check of one project. A project in a directory of the workspace (`dir`) runs there, and its checks are
 * named after it, as in `orders/architecture`, so the checks of several projects never share a name.
 */
export function projectChecks(facts: ProjectFacts, dir?: string): Check[] {
  const architecture = architectureCheck(facts)
  const coverage = coverageCheck(facts)
  const checks = [...(architecture ? [architecture] : []), ...qualityChecks(facts), ...(coverage ? [coverage] : [])]
  if (dir === undefined) return checks
  return checks.map(({ name, ...rest }) => ({ name: `${dir}/${name}`, dir, ...rest }))
}
