import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { NpmProjectScanner } from "../../../application/setup/ports.js"
import { FLAT_CONFIGS } from "./eslint-scope.js"

/** Directories that never hold a project of a workspace. Hidden ones neither. */
const NOT_PROJECTS = new Set(["src", "target", "node_modules"])
/** How deep below a workspace root a project is searched for, as for Maven projects. */
const MAX_PROJECT_DEPTH = 3
/** The file that makes a directory a Maven project. */
const MAVEN_BUILD = "pom.xml"

/**
 * The npm projects with ESLint `init` writes a check for: the root itself, or else each directory below it, up to
 * three levels down, that is not inside another one. A Maven project is never one, and none is looked for inside it.
 */
export const scanEslintProjects: NpmProjectScanner = (rootDir) => {
  if (existsSync(join(rootDir, MAVEN_BUILD))) return []
  const eslintConfig = eslintConfigOf(rootDir)
  if (eslintConfig !== undefined) return [{ npm: { eslintConfig } }]
  return projectsBelow(rootDir, 1).map(({ dir, eslintConfig }) => ({
    dir: relative(rootDir, dir).split(sep).join("/"),
    npm: { eslintConfig },
  }))
}

function projectsBelow(dir: string, depth: number): { dir: string; eslintConfig: string }[] {
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
      if (existsSync(join(child, MAVEN_BUILD))) return []
      const eslintConfig = eslintConfigOf(child)
      return eslintConfig === undefined ? projectsBelow(child, depth + 1) : [{ dir: child, eslintConfig }]
    })
}

/**
 * The flat ESLint configuration file of the directory, when its `package.json` also lists `eslint` among its
 * dependencies: the project then runs its own ESLint. Otherwise nothing (decision 56).
 */
function eslintConfigOf(dir: string): string | undefined {
  const config = FLAT_CONFIGS.find((name) => existsSync(join(dir, name)))
  return config !== undefined && dependsOnEslint(join(dir, "package.json")) ? config : undefined
}

function dependsOnEslint(packageJson: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(packageJson, "utf8"))
    if (!isRecord(manifest)) return false
    return [manifest.dependencies, manifest.devDependencies].some((group) => isRecord(group) && "eslint" in group)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
