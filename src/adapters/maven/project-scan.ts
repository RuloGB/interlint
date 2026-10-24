import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ProjectFacts } from "../../core/init.js"

export const TEST_SOURCES = "src/test/java"
const ARCH_TEST = /@(?:[\w.]+\.)?ArchTest\b/

/** What `interlint init` needs to know about a Maven project. */
export function scanProject(projectDir: string): ProjectFacts {
  return {
    archTestClasses: findArchTestClasses(projectDir),
    hasMavenWrapper: ["mvnw", "mvnw.cmd"].some((name) => existsSync(join(projectDir, name))),
  }
}

/** The test classes whose source has an `@ArchTest` field or method, by simple name. */
function findArchTestClasses(projectDir: string): string[] {
  const root = join(projectDir, TEST_SOURCES)
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".java") && ARCH_TEST.test(readFileSync(join(root, path), "utf8")))
    .map((path) => basename(path, ".java"))
}
