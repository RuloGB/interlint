export const QUALITY_PLUGINS = ["checkstyle", "pmd"] as const
export type QualityPlugin = (typeof QUALITY_PLUGINS)[number]

/** Where a Maven project keeps its test classes, and so its `@ArchTest` classes. */
export const TEST_SOURCES = "src/test/java"

/** What `interlint init` found in the project. */
export interface ProjectFacts {
  /** Simple names of the test classes with `@ArchTest`. */
  archTestClasses: string[]
  /** The modules that hold them, as `/`-separated paths relative to the project: `""` is the project itself. */
  archTestModules: string[]
  /** Whether the project is a reactor: its `pom.xml` declares modules. */
  hasModules: boolean
  hasMavenWrapper: boolean
  /** The Checkstyle and PMD plugins the project's own build declares. */
  qualityPlugins: QualityPlugin[]
  /** The ids of the build's executions that run each plugin's `check` goal. */
  checkExecutions: Record<QualityPlugin, string[]>
}

/** A class name made of letters, digits and `_` only. Anything else (`$`, `(`, `;`…) could mean something to the shell. */
const PLAIN_CLASS_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u

/**
 * The ArchUnit classes `-Dtest` will name, sorted. Surefire matches `-Dtest` by simple name, so two classes
 * with the same name appear once. A name that is not a plain class name is left out: it goes into a shell command.
 */
export function runnableClasses(facts: ProjectFacts): string[] {
  return [...new Set(facts.archTestClasses)].filter((name) => PLAIN_CLASS_NAME.test(name)).sort()
}
