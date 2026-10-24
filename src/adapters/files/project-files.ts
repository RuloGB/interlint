import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** A file `interlint init` wants in the project, by its `/`-separated path relative to the project. */
export interface PlannedFile {
  path: string
  content: string
  /** Whether a different file already there may be replaced. */
  replace: boolean
}

export type FileState = "new" | "changed" | "unchanged" | "conflict"

/** What writing `file` would do, without writing anything. */
export function stateOf(projectDir: string, file: PlannedFile): FileState {
  const path = join(projectDir, file.path)
  if (!existsSync(path)) return "new"
  if (readFileSync(path, "utf8") === file.content) return "unchanged"
  return file.replace ? "changed" : "conflict"
}

export function writeProjectFile(projectDir: string, file: PlannedFile) {
  const path = join(projectDir, file.path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, file.content)
}
