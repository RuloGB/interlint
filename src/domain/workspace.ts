/** The file that makes a directory a Maven project. */
export const MAVEN_BUILD_FILE = "pom.xml"

/** Directories that never hold a project of a workspace. Hidden ones neither. */
export const NOT_PROJECT_DIRS: ReadonlySet<string> = new Set(["src", "target", "node_modules"])

/** How deep below a workspace root a project is searched for, whatever its kind. */
export const MAX_PROJECT_DEPTH = 3
