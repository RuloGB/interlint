import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { type ProjectFacts, QUALITY_PLUGINS, type QualityPlugin } from "../../core/init.js"

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
/** A `<plugin>` element, never running into the next one. */
const PLUGIN_ELEMENT = /<plugin>((?:(?!<\/plugin>)[\s\S])*)<\/plugin>/g
const EXECUTION_ELEMENT = /<execution>([\s\S]*?)<\/execution>/g
const CHECK_GOAL = /<goal>\s*check\s*<\/goal>/
/** How a POM turns off an execution it inherits. */
const TURNED_OFF = /<phase>\s*none\s*<\/phase>/
const EXECUTION_ID = /<id>\s*([^<]*?)\s*<\/id>/
/** The id Maven gives an execution without `<id>`. */
const DEFAULT_EXECUTION_ID = "default"

/** What `interlint init` needs to know about a Maven project. */
export function scanProject(projectDir: string): ProjectFacts {
  return {
    archTestClasses: findArchTestClasses(projectDir),
    hasMavenWrapper: ["mvnw", "mvnw.cmd"].some((name) => existsSync(join(projectDir, name))),
    ...scanQualityPlugins(projectDir),
  }
}

/**
 * The Checkstyle and PMD plugins in the build of `pom.xml`, in `plugins` or `pluginManagement`, and the ids of
 * the executions that run their `check` goal.
 */
function scanQualityPlugins(projectDir: string): Pick<ProjectFacts, "qualityPlugins" | "checkExecutions"> {
  const pom = join(projectDir, "pom.xml")
  const build = existsSync(pom) ? readFileSync(pom, "utf8").replace(XML_COMMENTS, " ").replace(UNUSED_SECTIONS, " ") : ""
  const plugins = [...build.matchAll(PLUGIN_ELEMENT)].map((match) => match[1] ?? "")
  const declarationsOf = (plugin: QualityPlugin) =>
    plugins.filter((body) => new RegExp(`<artifactId>\\s*maven-${plugin}-plugin\\s*</artifactId>`).test(body))
  const checkExecutions = Object.fromEntries(
    QUALITY_PLUGINS.map((plugin) => [plugin, checkExecutionIds(declarationsOf(plugin))]),
  ) as Record<QualityPlugin, string[]>
  return {
    qualityPlugins: QUALITY_PLUGINS.filter((plugin) => declarationsOf(plugin).length > 0),
    checkExecutions,
  }
}

/** The ids of the executions that run `check` and are not turned off, once each and in order. */
function checkExecutionIds(declarations: string[]): string[] {
  const ids = declarations
    .flatMap((body) => [...body.matchAll(EXECUTION_ELEMENT)].map((match) => match[1] ?? ""))
    .filter((execution) => CHECK_GOAL.test(execution) && !TURNED_OFF.test(execution))
    .map((execution) => EXECUTION_ID.exec(execution)?.[1] || DEFAULT_EXECUTION_ID)
  return [...new Set(ids)]
}

/** The test classes whose code has an `@ArchTest` field or method, by simple name. */
function findArchTestClasses(projectDir: string): string[] {
  const root = join(projectDir, TEST_SOURCES)
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .filter((entry) => usesArchTest(readFileSync(join(entry.parentPath, entry.name), "utf8")))
    .map((entry) => basename(entry.name, ".java"))
}

function usesArchTest(source: string): boolean {
  return ARCH_TEST.test(source.replace(COMMENTS_AND_STRINGS, " "))
}
