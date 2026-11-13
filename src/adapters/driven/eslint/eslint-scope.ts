import { existsSync } from "node:fs"
import { join } from "node:path"
import type { EditScope } from "../../../application/checking/ports.js"
import { ESLINT_CONFIGS } from "../../../domain/eslint-command.js"

/** `eslint` as a word of the command, as in `npx --no -- eslint` or `node_modules/.bin/eslint`. */
const ESLINT = /(?:^|[\s/\\])eslint(?=\s)/
/** The whole project as the last argument: the one the edited files replace. */
const WHOLE_PROJECT = /\s\.\s*$/
/** Anything that makes the command more than one program with its arguments: the files could reach another program. */
const SHELL_OPERATORS = /[&|;<>`$()]/
/**
 * A path made of ASCII letters, digits, `_`, `.`, `-`, `/`, `@` and `+` only, and not starting with `-`. Anything else
 * could mean something to the shell or to ESLint, which reads its arguments as glob patterns and options.
 */
const PLAIN_PATH = /^(?!-)[\w.\-/@+]+$/
/** More files than this make a command line some shells cut: ESLint then checks the whole project. */
const MAX_FILES = 50
/**
 * Keeps ESLint from warning about a file its configuration ignores: under `--max-warnings 0` that warning alone
 * fails the run. Only the flat configuration has the option; with the older one ESLint rejects it.
 */
const NO_WARN_IGNORED = "--no-warn-ignored"

/**
 * Limits ESLint to the files, in place of the whole project (` .`) the command ends with. A file that is gone is
 * left out, since ESLint fails on a file it cannot find. The command stays as it is when it does not run ESLint on
 * the whole project that way, such as the project's `lint` script, when it is more than one program, when a file's
 * path is not plain, or when there are too many files or none left: ESLint then checks the whole project, and the
 * edit still shows only the failures of its files.
 */
export const eslintOnFiles: EditScope = (command, files, dir) => {
  if (!ESLINT.test(command) || !WHOLE_PROJECT.test(command) || SHELL_OPERATORS.test(command)) return command
  const present = [...new Set(files)].filter((file) => existsSync(join(dir, file)))
  if (present.length === 0 || present.length > MAX_FILES) return command
  if (!present.every((file) => PLAIN_PATH.test(file))) return command
  const flat = ESLINT_CONFIGS.some((name) => existsSync(join(dir, name)))
  return [command.replace(WHOLE_PROJECT, ""), ...(flat ? [NO_WARN_IGNORED] : []), ...present].join(" ")
}
