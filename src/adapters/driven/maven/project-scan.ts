import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import type { ProjectScanner } from "../../../application/setup/ports.js"
import { type ProjectFacts, QUALITY_PLUGINS, type QualityPlugin, TEST_SOURCES } from "../../../domain/project-facts.js"
import { MAX_PROJECT_DEPTH, NOT_PROJECT_DIRS } from "../../../domain/workspace.js"
import { declaredModules } from "./modules.js"

const ARCH_TEST = /@(?:[\w.]+\.)?ArchTest\b/
/**
 * Comments, string literals and char literals, matched left to right so a `//` inside a string
 * is not a comment and a `'"'` does not open a string.
 */
const COMMENTS_AND_STRINGS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g

const XML_COMMENTS = /<!--[\s\S]*?-->/g
/**
 * Sections where a Checkstyle or PMD artifactId does not declare a plugin the `check` goals use: a profile may be
 * off, reporting is for the site, and a dependency is a jar on a classpath, not a plugin of the build.
 */
const UNUSED_SECTIONS = /<(profiles|reporting|dependencyManagement|dependencies)>[\s\S]*?<\/\1>/g
const PLUGIN_MANAGEMENT = /<pluginManagement>[\s\S]*?<\/pluginManagement>/g
/** A `<plugin>` element, never running into the next one. */
const PLUGIN_ELEMENT = /<plugin>((?:(?!<\/plugin>)[\s\S])*)<\/plugin>/g
const EXECUTION_ELEMENT = /<execution>([\s\S]*?)<\/execution>/g
const CHECK_GOAL = /<goal>\s*check\s*<\/goal>/
/** How a POM turns off an execution it inherits. */
const TURNED_OFF = /<phase>\s*none\s*<\/phase>/
const EXECUTION_ID = /<id>\s*([^<]*?)\s*<\/id>/
const JACOCO_PLUGIN = "jacoco-maven-plugin"
/** The id Maven gives an execution without `<id>`. */
const DEFAULT_EXECUTION_ID = "default"

/**
 * The Maven projects Interlint runs from `rootDir`, as `/`-separated paths relative to it: the root itself (`""`)
 * when it has a `pom.xml`, and otherwise each directory below it with a `pom.xml` that is not inside another one
 * (a module of a project belongs to that project), up to three levels down. Directories without one, such as a
 * Node project, are not projects. When there are none, the root is the project, as before workspaces were supported.
 */
export function findMavenProjects(rootDir: string): string[] {
  if (existsSync(join(rootDir, "pom.xml"))) return [""]
  const projects = projectsBelow(rootDir, 1).map((dir) => relative(rootDir, dir).split(sep).join("/"))
  return projects.length > 0 ? projects : [""]
}

function projectsBelow(dir: string, depth: number): string[] {
  if (depth > MAX_PROJECT_DEPTH) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NOT_PROJECT_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const child = join(dir, name)
      return existsSync(join(child, "pom.xml")) ? [child] : projectsBelow(child, depth + 1)
    })
}

/** The Maven projects of `rootDir` and what `init` needs to know about each one. */
export const scanMavenProjects: ProjectScanner = (rootDir) =>
  findMavenProjects(rootDir).map((dir) => ({
    dir: dir === "" ? undefined : dir,
    facts: scanProject(dir === "" ? rootDir : join(rootDir, dir)),
  }))

/** What `interlint init` needs to know about a Maven project and its modules. */
export function scanProject(projectDir: string): ProjectFacts {
  const modules = declaredModules(projectDir)
  const archTests = modules.map((module) => ({ module, classes: findArchTestClasses(module) }))
  return {
    archTestClasses: archTests.flatMap(({ classes }) => classes),
    archTestModules: archTests
      .filter(({ classes }) => classes.length > 0)
      .map(({ module }) => relative(projectDir, module).split(sep).join("/")),
    hasModules: modules.length > 1,
    hasMavenWrapper: ["mvnw", "mvnw.cmd"].some((name) => existsSync(join(projectDir, name))),
    ...scanQualityPlugins(modules),
  }
}

/**
 * The Checkstyle and PMD plugins the build runs, and the ids of the executions that run their `check` goal, or
 * JaCoCo's `check` goal, which holds the coverage rules.
 * A plugin counts when a POM of the project declares it in `<build><plugins>`. In a project without modules it
 * also counts when its `pom.xml` only manages it in `pluginManagement`; in a reactor a managed plugin counts only
 * when some module turns it on, but the executions the parent manages are the ones the modules run.
 */
function scanQualityPlugins(
  modules: string[],
): Pick<ProjectFacts, "qualityPlugins" | "checkExecutions" | "coverageExecutions"> {
  const poms = modules.map((module) => readBuild(join(module, "pom.xml")))
  const activeOf = (build: string) => pluginsIn(build.replace(PLUGIN_MANAGEMENT, " "))
  const managedOf = (build: string) => [...build.matchAll(PLUGIN_MANAGEMENT)].flatMap((match) => pluginsIn(match[0]))
  const active = poms.flatMap(activeOf)
  const declared = poms.flatMap((build) => [...managedOf(build), ...activeOf(build)])
  const counted = modules.length > 1 ? active : declared
  const declarationsOf = (plugins: string[], artifactId: string) =>
    plugins.filter((body) => new RegExp(`<artifactId>\\s*${artifactId}\\s*</artifactId>`).test(body))
  const qualityPlugin = (plugin: QualityPlugin) => `maven-${plugin}-plugin`
  const checkExecutions = Object.fromEntries(
    QUALITY_PLUGINS.map((plugin) => [plugin, checkExecutionIds(declarationsOf(declared, qualityPlugin(plugin)))]),
  ) as Record<QualityPlugin, string[]>
  const jacoco = declarationsOf(counted, JACOCO_PLUGIN).length > 0
  return {
    qualityPlugins: QUALITY_PLUGINS.filter((plugin) => declarationsOf(counted, qualityPlugin(plugin)).length > 0),
    checkExecutions,
    coverageExecutions: jacoco ? checkExecutionIds(declarationsOf(declared, JACOCO_PLUGIN)) : [],
  }
}

/** The `<build>` part of a POM that can declare a plugin the `check` goals use, or nothing without a POM. */
function readBuild(pom: string): string {
  return existsSync(pom) ? readFileSync(pom, "utf8").replace(XML_COMMENTS, " ").replace(UNUSED_SECTIONS, " ") : ""
}

function pluginsIn(xml: string): string[] {
  return [...xml.matchAll(PLUGIN_ELEMENT)].map((match) => match[1] ?? "")
}

/** The ids of the executions that run `check` and are not turned off, once each and in order. */
function checkExecutionIds(declarations: string[]): string[] {
  const ids = declarations
    .flatMap((body) => [...body.matchAll(EXECUTION_ELEMENT)].map((match) => match[1] ?? ""))
    .filter((execution) => CHECK_GOAL.test(execution) && !TURNED_OFF.test(execution))
    .map((execution) => EXECUTION_ID.exec(execution)?.[1] || DEFAULT_EXECUTION_ID)
  return [...new Set(ids)]
}

/** The test classes of one module whose code has an `@ArchTest` field or method, by simple name. */
function findArchTestClasses(moduleDir: string): string[] {
  const root = join(moduleDir, TEST_SOURCES)
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .filter((entry) => usesArchTest(readFileSync(join(entry.parentPath, entry.name), "utf8")))
    .map((entry) => basename(entry.name, ".java"))
}

function usesArchTest(source: string): boolean {
  return ARCH_TEST.test(source.replace(COMMENTS_AND_STRINGS, " "))
}
