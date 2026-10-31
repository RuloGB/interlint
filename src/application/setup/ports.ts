import type { Config } from "../../domain/check.js"
import type { ProjectFacts } from "../../domain/project-facts.js"

/** A file `interlint init` wants in the project, by its `/`-separated path relative to the project. */
export interface PlannedFile {
  path: string
  content: string
  /** Whether a different file already there may be replaced. */
  replace: boolean
}

export type FileState = "new" | "changed" | "unchanged" | "conflict"

export interface ProjectFiles {
  /** What writing `file` would do, without writing anything. */
  stateOf(projectDir: string, file: PlannedFile): FileState
  write(projectDir: string, file: PlannedFile): void
}

/** One project `init` found, with its `/`-separated `dir` relative to the root, absent for the root itself. */
export interface ScannedProject {
  dir?: string
  facts: ProjectFacts
}

/** The root itself when it is a project, or else each project below it. */
export type ProjectScanner = (rootDir: string) => ScannedProject[]

/** The file `init` writes the checks to. */
export interface ConfigFile {
  path: string
  render(config: Config): string
}

/** The files that hook an agent up to Interlint. Throws `AgentSetupError` when the project's own files are unusable. */
export type AgentFiles = (projectDir: string) => PlannedFile[]

export class AgentSetupError extends Error {}
