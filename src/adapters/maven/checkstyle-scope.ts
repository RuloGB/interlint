import type { EditScope } from "../../core/ports.js"

/** `checkstyle:check`, plain or naming an execution (`checkstyle:check@style`), as a word of the command. */
const CHECKSTYLE_CHECK = /(?:^|\s)checkstyle:check(?:@\S+)?(?=\s|$)/
const INCLUDES_SET = /\s-Dcheckstyle\.includes=/
/** Checkstyle matches `includes` against a source's path from its source root, as in `shop/Order.java`. */
const SOURCE_ROOT = /(?:^|\/)src\/(?:main|test)\/java\/(.+)$/
/** A pattern made of letters, digits, `_`, `.`, `-`, `/` and `*` only. Anything else could mean something to the shell. */
const PLAIN_PATTERN = /^[\p{L}\p{N}_.\-/*]+$/u

/**
 * Limits `checkstyle:check` to the files with `-Dcheckstyle.includes`. The rest of the build's configuration,
 * including that of the execution the goal names, still applies. A command that sets `checkstyle.includes` itself,
 * or a file whose pattern could mean something to the shell, leaves the command as it is: Checkstyle then checks
 * the whole project, and the edit still shows only the failures of its files.
 */
export const checkstyleOnFiles: EditScope = (command, files) => {
  if (!CHECKSTYLE_CHECK.test(command) || INCLUDES_SET.test(command)) return command
  const patterns = [...new Set(files.map(includePattern))]
  if (patterns.length === 0 || !patterns.every((pattern) => PLAIN_PATTERN.test(pattern))) return command
  return `${command} -Dcheckstyle.includes=${patterns.join(",")}`
}

/** The file's path from its source root, or, outside the usual layout, its name in any directory. */
function includePattern(file: string): string {
  return SOURCE_ROOT.exec(file)?.[1] ?? `**/${file.split("/").at(-1)}`
}
