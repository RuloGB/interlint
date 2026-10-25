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

/** What `interlint init` needs to know about a Maven project. */
export function scanProject(projectDir: string): ProjectFacts {
  return {
    archTestClasses: findArchTestClasses(projectDir),
    hasMavenWrapper: ["mvnw", "mvnw.cmd"].some((name) => existsSync(join(projectDir, name))),
    qualityPlugins: findQualityPlugins(projectDir),
  }
}

/** The Checkstyle and PMD plugins in the build of `pom.xml`, in `plugins` or `pluginManagement`. */
function findQualityPlugins(projectDir: string): QualityPlugin[] {
  const pom = join(projectDir, "pom.xml")
  if (!existsSync(pom)) return []
  const build = readFileSync(pom, "utf8").replace(XML_COMMENTS, " ").replace(UNUSED_SECTIONS, " ")
  return QUALITY_PLUGINS.filter((plugin) =>
    new RegExp(`<artifactId>\\s*maven-${plugin}-plugin\\s*</artifactId>`).test(build),
  )
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
