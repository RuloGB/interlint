import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { AGENTS, type Agent, type InitDeps, initProject } from "../../../application/setup/init-project.js"
import { AgentSetupError, type MavenProject, type ScannedProject } from "../../../application/setup/ports.js"
import {
  architectureCheck,
  coverageCheck,
  projectChecks,
  QUALITY_EVERY,
  SLOW_CHECK_EVERY,
  SLOW_CHECK_LINES,
} from "../../../domain/check-plan.js"
import { mavenCommand, usesMaven } from "../../../domain/maven-command.js"
import {
  type ProjectFacts,
  QUALITY_PLUGINS,
  type QualityPlugin,
  runnableClasses,
  TEST_SOURCES,
} from "../../../domain/project-facts.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"

const QUALITY_TOOLS: Record<QualityPlugin, string> = { checkstyle: "Checkstyle", pmd: "PMD" }
/**
 * What `init` looks for besides Maven projects, said when it finds nothing at all. A Maven project at the root is
 * never searched for an npm project, so it is not said there.
 */
const NO_NPM_PROJECT = " No npm project with ESLint (eslint in package.json and an eslint.config file) was found either."

export function init(args: string[], io: Io, deps: InitDeps): number {
  const { values } = parseInitArgs(args)
  const agent = values.agent
  if (agent !== undefined && !(AGENTS as readonly string[]).includes(agent)) {
    throw new UsageError(`--agent must be ${AGENTS.join(" or ")} (got "${agent}")`)
  }

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  if (!existsSync(projectDir)) throw new UsageError(`${projectDir} does not exist`)
  const result = initOrUsageError(projectDir, agent as Agent | undefined, values.force === true, deps)

  if (result.status === "nothing-to-check") {
    const noNpmProject = existsSync(join(projectDir, "pom.xml")) ? "" : NO_NPM_PROJECT
    // The root itself when it has a pom.xml, or else each Maven project of the workspace, in its own directory.
    if (result.projects[0]?.dir === undefined) {
      throw new UsageError(
        `nothing to check: no file under ${TEST_SOURCES} contains @ArchTest, and the build in pom.xml has no maven-checkstyle-plugin, maven-pmd-plugin or jacoco-maven-plugin check.${noNpmProject} Nothing was written.`,
      )
    }
    throw new UsageError(
      `nothing to check: no Maven project has a file under ${TEST_SOURCES} with @ArchTest, or maven-checkstyle-plugin, maven-pmd-plugin or a jacoco-maven-plugin check in its build (found: ${result.projects.map(({ dir }) => dir).join(", ")}).${noNpmProject} Nothing was written.`,
    )
  }
  if (result.status === "conflicts") {
    const conflicts = result.paths
    const [verb, adjective] = conflicts.length === 1 ? ["exists", "is"] : ["exist", "are"]
    throw new UsageError(
      `${conflicts.join(", ")} already ${verb} and ${adjective} different from what init would write; rerun with --force to replace ${conflicts.length === 1 ? "it" : "them"}`,
    )
  }

  const { projects } = result
  const single = projects.length === 1 && projects[0]?.dir === undefined
  const maven = projects.filter((project): project is MavenProject => "facts" in project)
  const kinds = editCheckKinds(maven.map(({ facts }) => facts))
  const groups = bySchedule(kinds)
  const plural = (tools: string[]) => !single || tools.length > 1
  const subject = (tools: string[]) => `the ${listOf(tools)} ${plural(tools) ? "checks run" : "check runs"}`
  const all = kinds.map(({ tool }) => tool)
  const daemon = result.daemonOnPath
    ? `on the PATH, so ${groups.map(({ tools, every }) => `${subject(tools)} ${schedule(every)}`).join(", and ")}`
    : `not on the PATH, so ${subject(all)} at task end; install mvnd to run ${plural(all) ? "them" : "it"} ${groups.length === 1 ? schedule(groups[0]?.every) : "after edits"}`
  const detected = single
    ? ["Detected:", ...detectedLines(projects[0]!, "  ")]
    : [
        `Detected ${projects.length} ${maven.length === projects.length ? "Maven projects" : "projects"}:`,
        ...projects.flatMap((project) => [`  ${project.dir ?? "."}`, ...detectedLines(project, "    ")]),
      ]
  io.stdout(
    [
      ...detected,
      ...(result.checks.some((check) => check.when === "edit" && usesMaven(check.run)) ? [`  mvnd: ${daemon}`] : []),
      "",
      ...section("Wrote:", result.written),
      ...section("Unchanged:", result.unchanged),
      ...section(
        "Kept:",
        result.kept.map((path) => `${path} (differs from what init would write; rerun with --force to replace it)`),
      ),
    ].join("\n"),
  )
  return EXIT.passed
}

function initOrUsageError(projectDir: string, agent: Agent | undefined, force: boolean, deps: InitDeps) {
  try {
    return initProject(projectDir, { agent, force }, deps)
  } catch (error) {
    if (error instanceof AgentSetupError) throw new UsageError(`${error.message}. Nothing was written.`)
    throw error
  }
}

interface EditCheckKind {
  tool: string
  every: number | undefined
}

/** What the edit checks `init` writes check, as the mvnd line names them, with their `every`. */
function editCheckKinds(projects: ProjectFacts[]): EditCheckKind[] {
  const architecture = projects.some((facts) => architectureCheck(facts) !== undefined)
    ? [{ tool: "ArchUnit", every: SLOW_CHECK_EVERY }]
    : []
  const quality = QUALITY_PLUGINS.filter((plugin) => projects.some((facts) => facts.qualityPlugins.includes(plugin)))
  return [...architecture, ...quality.map((plugin) => ({ tool: QUALITY_TOOLS[plugin], every: QUALITY_EVERY[plugin] }))]
}

/** The kinds grouped by `every`, those that run after each edit first. */
function bySchedule(kinds: EditCheckKind[]): { tools: string[]; every: number | undefined }[] {
  const groups = new Map<number | undefined, string[]>()
  for (const { tool, every } of [...kinds].sort((a, b) => (a.every ?? 1) - (b.every ?? 1))) {
    groups.set(every, [...(groups.get(every) ?? []), tool])
  }
  return [...groups].map(([every, tools]) => ({ tools, every }))
}

function schedule(every: number | undefined): string {
  return every === undefined ? "after each edit" : `after every ${every} edited files or ${SLOW_CHECK_LINES} written lines`
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** What `init` found in one project. In a workspace, a Maven project with nothing to check says so. */
function detectedLines(project: ScannedProject, indent: string): string[] {
  if ("npm" in project) {
    return [`${indent}ESLint: eslint in package.json and ${project.npm.eslintConfig}, so the eslint check runs after each edit`]
  }
  const { facts } = project
  if (projectChecks(facts).length === 0 && facts.archTestModules.length === 0) return [`${indent}nothing to check`]
  const modules = facts.archTestModules.filter((module) => module !== "")
  return [
    `${indent}ArchUnit tests: ${runnableClasses(facts).join(", ") || "none"}${modules.length > 0 ? ` (in ${modules.join(", ")})` : ""}`,
    ...facts.qualityPlugins.map((plugin) => `${indent}${QUALITY_TOOLS[plugin]}: maven-${plugin}-plugin in pom.xml`),
    ...(coverageCheck(facts) === undefined
      ? []
      : [`${indent}JaCoCo: jacoco-maven-plugin check in pom.xml, so the coverage check runs at task end`]),
    `${indent}Maven: ${mavenCommand(facts)} (${facts.hasMavenWrapper ? "Maven Wrapper" : "no Maven Wrapper"})`,
  ]
}

function section(title: string, paths: string[]): string[] {
  return paths.length === 0 ? [] : [title, ...paths.map((path) => `  ${path}`), ""]
}

function parseInitArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { agent: { type: "string" }, force: { type: "boolean" }, cwd: { type: "string" } },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
