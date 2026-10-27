import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { EditScope } from "../../core/ports.js"
import { moduleDirs } from "./modules.js"

/** `checkstyle:check`, plain or naming an execution (`checkstyle:check@style`), as a word of the command. */
const CHECKSTYLE_CHECK = /(?:^|\s)checkstyle:check(?:@\S+)?(?=\s|$)/
/** `-Dcheckstyle.includes=` in the command, quoted or not. */
const INCLUDES_SET = /(?:^|[\s"'])-Dcheckstyle\.includes=/
/** Anything that makes the command more than one program with its arguments: an appended property would miss Maven. */
const SHELL_OPERATORS = /[&|;<>`$()]/
/** Checkstyle matches `includes` against a source's path from its source root, as in `shop/Order.java`. */
const SOURCE_ROOT = /(?:^|\/)src\/(?:main|test)\/java\/(.+)$/
/**
 * A pattern made of ASCII letters, digits, `_`, `.`, `-`, `/` and `*` only. Anything else could mean something to the
 * shell, or reach the JVM in another encoding than the file system's, so Checkstyle would match nothing.
 */
const PLAIN_PATTERN = /^[\w.\-/*]+$/
/** Leaves the project's resources out, so the report holds only the files: its most severe level is then theirs. */
const ONLY_SOURCES = "-Dcheckstyle.includeResources=false -Dcheckstyle.includeTestResources=false"

/**
 * Limits `checkstyle:check` to the files with `-Dcheckstyle.includes`. The rest of the build's configuration,
 * including that of the execution the goal names, still applies. The command stays as it is when it sets
 * `checkstyle.includes` itself, when the project does (a property in a `pom.xml` or `.mvn/maven.config`, which the
 * appended one would replace, so the edit would check files the build never checks), when it is more than one
 * program, or when a file's pattern is not plain: Checkstyle then checks the whole project, and the edit still shows
 * only the failures of its files.
 */
export const checkstyleOnFiles: EditScope = (command, files, dir) => {
  if (!CHECKSTYLE_CHECK.test(command) || INCLUDES_SET.test(command) || SHELL_OPERATORS.test(command)) return command
  const patterns = [...new Set(files.map(includePattern))]
  if (patterns.length === 0 || !patterns.every((pattern) => PLAIN_PATTERN.test(pattern))) return command
  if (projectSetsIncludes(dir)) return command
  return `${command} -Dcheckstyle.includes=${patterns.join(",")} ${ONLY_SOURCES}`
}

/** The file's path from its source root, or, outside the usual layout, its name in any directory. */
function includePattern(file: string): string {
  return SOURCE_ROOT.exec(file)?.[1] ?? `**/${file.split("/").at(-1)}`
}

/** Whether `.mvn/maven.config` or the `pom.xml` of the project or of any of its modules names `checkstyle.includes`. */
function projectSetsIncludes(dir: string): boolean {
  const files = [join(dir, ".mvn", "maven.config"), ...moduleDirs(dir).map((module) => join(module, "pom.xml"))]
  return files.some((file) => readOrEmpty(file).includes("checkstyle.includes"))
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
