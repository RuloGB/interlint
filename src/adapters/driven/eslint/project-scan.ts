import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { NpmProject, NpmProjectScanner } from "../../../application/setup/ports.js"
import { MAVEN_BUILD_FILE, MAX_PROJECT_DEPTH, NOT_PROJECT_DIRS } from "../../../domain/workspace.js"
import { FLAT_CONFIGS } from "./eslint-scope.js"

const MANIFEST = "package.json"
/** Build and coverage output of an npm project, which may hold a copy of its `package.json`. */
const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(["dist", "build", "coverage"])

/** What a directory holds: an npm project with ESLint, a manifest that cannot be read next to a configuration, or neither. */
type Found = { eslintConfig: string } | { unreadable: true } | undefined

/**
 * The npm projects with ESLint `init` writes a check for: the root itself, or else each directory below it, up to
 * three levels down, that is not inside another one or in build output. A Maven project is never one, and none is
 * looked for inside it: at a Maven root nothing is searched.
 */
export const scanEslintProjects: NpmProjectScanner = (rootDir) => {
  if (existsSync(join(rootDir, MAVEN_BUILD_FILE))) return { searched: false, projects: [], unreadable: [] }
  const projects: NpmProject[] = []
  const unreadable: string[] = []
  const visit = (dir: string, depth: number): void => {
    const found = inspect(dir)
    const path = relative(rootDir, dir).split(sep).join("/")
    if (found !== undefined && "eslintConfig" in found) {
      projects.push({ ...(path === "" ? {} : { dir: path }), npm: { eslintConfig: found.eslintConfig } })
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
 * A directory is an npm project with ESLint when it has a flat ESLint configuration file and its `package.json`
 * lists `eslint` among its dependencies: the project then runs its own ESLint (decision 56).
 */
function inspect(dir: string): Found {
  const eslintConfig = FLAT_CONFIGS.find((name) => existsSync(join(dir, name)))
  const manifest = join(dir, MANIFEST)
  if (eslintConfig === undefined || !existsSync(manifest)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    return { unreadable: true }
  }
  if (!isRecord(parsed)) return { unreadable: true }
  const listsEslint = [parsed.dependencies, parsed.devDependencies].some((group) => isRecord(group) && "eslint" in group)
  return listsEslint ? { eslintConfig } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
