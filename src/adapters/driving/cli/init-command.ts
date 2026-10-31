import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { AGENTS, type Agent, type InitDeps, initProject } from "../../../application/setup/init-project.js"
import { AgentSetupError } from "../../../application/setup/ports.js"
import { projectChecks } from "../../../domain/check-plan.js"
import { mavenCommand } from "../../../domain/maven-command.js"
import {
  type ProjectFacts,
  QUALITY_PLUGINS,
  type QualityPlugin,
  runnableClasses,
  TEST_SOURCES,
} from "../../../domain/project-facts.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"

const QUALITY_TOOLS: Record<QualityPlugin, string> = { checkstyle: "Checkstyle", pmd: "PMD" }

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
    // The root itself when it has a pom.xml, or else each Maven project of the workspace, in its own directory.
    if (result.projects[0]?.dir === undefined) {
      throw new UsageError(
        `nothing to check: no file under ${TEST_SOURCES} contains @ArchTest, and the build in pom.xml has neither maven-checkstyle-plugin nor maven-pmd-plugin. Nothing was written.`,
      )
    }
    throw new UsageError(
      `nothing to check: no Maven project has a file under ${TEST_SOURCES} with @ArchTest, or maven-checkstyle-plugin or maven-pmd-plugin in its build (found: ${result.projects.map(({ dir }) => dir).join(", ")}). Nothing was written.`,
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
  const kinds = editCheckKinds(projects.map(({ facts }) => facts))
  const plural = !single || kinds.length > 1
  const subject = `${listOf(kinds)} ${plural ? "checks run" : "check runs"}`
  const daemon = result.daemonOnPath
    ? `on the PATH, so the ${subject} after each edit`
    : `not on the PATH, so the ${subject} at task end; install mvnd to run ${plural ? "them" : "it"} after each edit`
  const detected = single
    ? ["Detected:", ...detectedLines(projects[0]!.facts, "  ")]
    : [
        `Detected ${projects.length} Maven projects:`,
        ...projects.flatMap(({ dir, facts }) => [`  ${dir}`, ...detectedLines(facts, "    ")]),
      ]
  io.stdout(
    [
      ...detected,
      ...(result.checks.some((check) => check.when === "edit") ? [`  mvnd: ${daemon}`] : []),
      "",
      ...section("Wrote:", result.written),
      ...section("Unchanged:", result.unchanged),
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

/** What the edit checks `init` writes check, as the mvnd line names them. */
function editCheckKinds(projects: ProjectFacts[]): string[] {
  const architecture = projects.some((facts) => runnableClasses(facts).length > 0) ? ["architecture"] : []
  const quality = QUALITY_PLUGINS.filter((plugin) => projects.some((facts) => facts.qualityPlugins.includes(plugin)))
  return [...architecture, ...quality.map((plugin) => QUALITY_TOOLS[plugin])]
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** What `init` found in one project. In a workspace, a project with nothing to check says so. */
function detectedLines(facts: ProjectFacts, indent: string): string[] {
  if (projectChecks(facts).length === 0 && facts.archTestModules.length === 0) return [`${indent}nothing to check`]
  const modules = facts.archTestModules.filter((module) => module !== "")
  return [
    `${indent}ArchUnit tests: ${runnableClasses(facts).join(", ") || "none"}${modules.length > 0 ? ` (in ${modules.join(", ")})` : ""}`,
    ...facts.qualityPlugins.map((plugin) => `${indent}${QUALITY_TOOLS[plugin]}: maven-${plugin}-plugin in pom.xml`),
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
