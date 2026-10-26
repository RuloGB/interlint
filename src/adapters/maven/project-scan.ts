import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import { type ProjectFacts, QUALITY_PLUGINS, type QualityPlugin } from "../../core/init.js"
import { declaredModules } from "./modules.js"

export const TEST_SOURCES = "src/test/java"
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
/** The id Maven gives an execution without `<id>`. */
const DEFAULT_EXECUTION_ID = "default"

/** Directories that never hold a Maven project of a workspace. Hidden ones neither. */
const NOT_PROJECTS = new Set(["src", "target", "node_modules"])
/** How deep below a workspace root a Maven project is searched for. */
const MAX_PROJECT_DEPTH = 3

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
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NOT_PROJECTS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const child = join(dir, name)
      return existsSync(join(child, "pom.xml")) ? [child] : projectsBelow(child, depth + 1)
    })
}

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
 * The Checkstyle and PMD plugins the build runs, and the ids of the executions that run their `check` goal.
 * A plugin counts when a POM of the project declares it in `<build><plugins>`. In a project without modules it
 * also counts when its `pom.xml` only manages it in `pluginManagement`; in a reactor a managed plugin counts only
 * when some module turns it on, but the executions the parent manages are the ones the modules run.
 */
function scanQualityPlugins(modules: string[]): Pick<ProjectFacts, "qualityPlugins" | "checkExecutions"> {
  const poms = modules.map((module) => readBuild(join(module, "pom.xml")))
  const activeOf = (build: string) => pluginsIn(build.replace(PLUGIN_MANAGEMENT, " "))
  const managedOf = (build: string) => [...build.matchAll(PLUGIN_MANAGEMENT)].flatMap((match) => pluginsIn(match[0]))
  const active = poms.flatMap(activeOf)
  const declared = poms.flatMap((build) => [...managedOf(build), ...activeOf(build)])
  const counted = modules.length > 1 ? active : declared
  const declarationsOf = (plugins: string[], plugin: QualityPlugin) =>
    plugins.filter((body) => new RegExp(`<artifactId>\\s*maven-${plugin}-plugin\\s*</artifactId>`).test(body))
  const checkExecutions = Object.fromEntries(
    QUALITY_PLUGINS.map((plugin) => [plugin, checkExecutionIds(declarationsOf(declared, plugin))]),
  ) as Record<QualityPlugin, string[]>
  return {
    qualityPlugins: QUALITY_PLUGINS.filter((plugin) => declarationsOf(counted, plugin).length > 0),
    checkExecutions,
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
