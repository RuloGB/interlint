import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { NpmProject, NpmProjectScanner } from "../../../application/setup/ports.js"
import { DEPCRUISE_CONFIGS } from "../../../domain/depcruise-command.js"
import { ESLINT_CONFIGS } from "../../../domain/eslint-command.js"
import type { NpmFacts } from "../../../domain/project-facts.js"
import { MAVEN_BUILD_FILE, MAX_PROJECT_DEPTH, NOT_PROJECT_DIRS } from "../../../domain/workspace.js"

const MANIFEST = "package.json"
/** Build and coverage output of an npm project, which may hold a copy of its `package.json`. */
const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(["dist", "build", "coverage"])

/**
 * What a directory holds: an npm project with ESLint or dependency-cruiser, a manifest that cannot be read next to
 * one of their configurations, or neither.
 */
type Found = { facts: NpmFacts } | { unreadable: true } | undefined

/**
 * The npm projects with ESLint or dependency-cruiser `init` writes checks for: the root itself, or else each directory below it, up to
 * three levels down, that is not inside another one or in build output. A Maven project is never one, and none is
 * looked for inside it: at a Maven root nothing is searched.
 */
export const scanNpmProjects: NpmProjectScanner = (rootDir) => {
  if (existsSync(join(rootDir, MAVEN_BUILD_FILE))) return { searched: false, projects: [], unreadable: [] }
  const projects: NpmProject[] = []
  const unreadable: string[] = []
  const visit = (dir: string, depth: number): void => {
    const found = inspect(dir)
    const path = relative(rootDir, dir).split(sep).join("/")
    if (found !== undefined && "facts" in found) {
      projects.push({ ...(path === "" ? {} : { dir: path }), npm: found.facts })
      return
    }
    if (found !== undefined) unreadable.push(path === "" ? MANIFEST : `${path}/${MANIFEST}`)
    if (depth >= MAX_PROJECT_DEPTH) return
    for (const child of childDirs(dir)) {
      if (!existsSync(join(child, MAVEN_BUILD_FILE))) visit(child, depth + 1)
    }
  }
  visit(rootDir, 0)
  return { searched: true, projects, unreadable }
}

/** The directories below `dir` that can hold a project, sorted by name. */
function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !NOT_PROJECT_DIRS.has(entry.name) &&
          !BUILD_OUTPUT_DIRS.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * A directory is an npm project with a tool when it has the tool's configuration file and its `package.json` lists
 * the tool among its dependencies: the project then runs its own copy (decision 56). The tools are ESLint, with a
 * flat configuration, and dependency-cruiser.
 */
function inspect(dir: string): Found {
  const eslintConfig = ESLINT_CONFIGS.find((name) => existsSync(join(dir, name)))
  const depcruiseConfig = DEPCRUISE_CONFIGS.find((name) => existsSync(join(dir, name)))
  const manifest = join(dir, MANIFEST)
  if ((eslintConfig === undefined && depcruiseConfig === undefined) || !existsSync(manifest)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    return { unreadable: true }
  }
  if (!isRecord(parsed)) return { unreadable: true }
  const lists = (name: string) => [parsed.dependencies, parsed.devDependencies].some((group) => isRecord(group) && name in group)
  const facts: NpmFacts = {
    ...(eslintConfig !== undefined && lists("eslint") ? { eslintConfig } : {}),
    ...(depcruiseConfig !== undefined && lists("dependency-cruiser") ? { depcruiseConfig } : {}),
  }
  return facts.eslintConfig === undefined && facts.depcruiseConfig === undefined ? undefined : { facts }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
