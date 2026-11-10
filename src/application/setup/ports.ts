import type { Config } from "../../domain/check.js"
import type { NpmFacts, ProjectFacts } from "../../domain/project-facts.js"

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

/** One Maven project `init` found, with its `/`-separated `dir` relative to the root, absent for the root itself. */
export interface MavenProject {
  dir?: string
  facts: ProjectFacts
}

/** One npm project with ESLint `init` found, with its `dir` as a Maven project's. */
export interface NpmProject {
  dir?: string
  npm: NpmFacts
}

export type ScannedProject = MavenProject | NpmProject

/**
 * The root itself when it is a Maven project, or else each one below it, sorted by directory. When there is none,
 * the root alone, as a project with nothing to check.
 */
export type ProjectScanner = (rootDir: string) => MavenProject[]

/**
 * The root itself when it is an npm project with ESLint, or else each one below it, and none when there is none.
 * A Maven project is never one, and none is looked for inside it (decision 55).
 */
export type NpmProjectScanner = (rootDir: string) => NpmProject[]

/** The file `init` writes the checks to. */
export interface ConfigFile {
  path: string
  render(config: Config): string
}

/** The files that hook an agent up to Interlint. Throws `AgentSetupError` when the project's own files are unusable. */
export type AgentFiles = (projectDir: string) => PlannedFile[]

export class AgentSetupError extends Error {}
