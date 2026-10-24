import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ProjectFacts } from "../../core/init.js"

export const TEST_SOURCES = "src/test/java"
const ARCH_TEST = /@(?:[\w.]+\.)?ArchTest\b/
/**
 * Comments, string literals and char literals, matched left to right so a `//` inside a string
 * is not a comment and a `'"'` does not open a string.
 */
const COMMENTS_AND_STRINGS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g

/** What `interlint init` needs to know about a Maven project. */
export function scanProject(projectDir: string): ProjectFacts {
  return {
    archTestClasses: findArchTestClasses(projectDir),
    hasMavenWrapper: ["mvnw", "mvnw.cmd"].some((name) => existsSync(join(projectDir, name))),
  }
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
