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

/**
 * The check that runs only the ArchUnit test classes, or nothing when there are none.
 * Always `when: edit`: without mvnd it waits for task end anyway, so the file is the same on every machine.
 * `test` runs the lifecycle, so it skips the Checkstyle and PMD plugins the build declares: bound to an early
 * phase, their failure would stop the build before ArchUnit runs, and their own checks already report it.
 */
export function architectureCheck(facts: ProjectFacts): Check | undefined {
  const classes = runnableClasses(facts).join(",")
  if (classes === "") return undefined
  const reactor = facts.hasModules ? " -Dsurefire.failIfNoSpecifiedTests=false" : ""
  const skips = QUALITY_PLUGINS.filter((plugin) => facts.qualityPlugins.includes(plugin)).map((plugin) => ` -D${plugin}.skip`)
  return {
    name: "architecture",
    run: `${mavenCommand(facts)} -q test${reactorArgs(facts)} -Dtest=${classes}${reactor}${skips.join("")}`,
    report: "archunit",
    when: "edit",
  }
}

/**
 * One check per Checkstyle or PMD plugin the build declares. Each runs its own goal: in one Maven call the
 * first failing goal stops the rest. Always `when: edit`, as the architecture check: at edit Checkstyle checks only
 * the changed files and both show only their failures; without mvnd they wait for task end.
 */
export function qualityChecks(facts: ProjectFacts): Check[] {
  return QUALITY_PLUGINS.filter((plugin) => facts.qualityPlugins.includes(plugin)).map((plugin) => ({
    name: plugin,
    run: `${mavenCommand(facts)} -q ${QUALITY_COMMANDS[plugin](checkGoal(facts, plugin))}`,
    report: "maven",
    when: "edit",
  }))
}

/**
 * Every check of one project. A project in a directory of the workspace (`dir`) runs there, and its checks are
 * named after it, as in `orders/architecture`, so the checks of several projects never share a name.
 */
export function projectChecks(facts: ProjectFacts, dir?: string): Check[] {
  const architecture = architectureCheck(facts)
  const checks = [...(architecture ? [architecture] : []), ...qualityChecks(facts)]
  if (dir === undefined) return checks
  return checks.map(({ name, run, report, when }) => ({ name: `${dir}/${name}`, dir, run, report, when }))
}
