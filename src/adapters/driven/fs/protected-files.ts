import { createHash } from "node:crypto"
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ProtectedFiles } from "../../../application/checking/ports.js"
import { type Fingerprint, globPattern, isLiteral, normalized, patternBase } from "../../../domain/protected-files.js"

/** Directories a glob never walks into: dependencies, version control and build output hold no rule of the team's. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "target"])

/**
 * Hashes the files the patterns match. A path is walked only from the leading directories of its pattern, and a
 * pattern without wildcards is read directly, so a narrow list costs a few reads.
 */
export const diskProtectedFiles: ProtectedFiles = (projectDir, patterns) => {
  const fingerprint: Record<string, string> = {}
  for (const pattern of patterns.map(normalized)) {
    const paths = isLiteral(pattern) ? [pattern] : matching(projectDir, pattern)
    for (const path of paths) {
      if (fingerprint[path] !== undefined) continue
      const hash = hashOf(join(projectDir, path))
      if (hash !== undefined) fingerprint[path] = hash
    }
  }
  return fingerprint as Fingerprint
}

function matching(projectDir: string, pattern: string): string[] {
  const regex = globPattern(pattern)
  const found: string[] = []
  const walk = (relative: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(projectDir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path)
      } else if (entry.isFile() && regex.test(path)) {
        found.push(path)
      }
    }
  }
  walk(patternBase(pattern))
  return found.sort()
}

/** The file's sha256, or `undefined` when it is not a file that can be read. */
function hashOf(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return undefined
  }
}
