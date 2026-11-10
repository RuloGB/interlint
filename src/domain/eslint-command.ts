/**
 * Where an ESLint check writes its JSON report, `/`-separated and relative to its project (decision 51). The reader
 * is not told the command, so the path is fixed. `node_modules/.cache` is outside git and outside the files whose
 * change runs the checks again at task end, and ESLint creates it.
 */
export const ESLINT_REPORT = "node_modules/.cache/interlint/eslint.json"

/**
 * The project's own ESLint on the whole project, with its report where the reader looks for it (decision 52).
 * `--no` keeps npx from downloading ESLint when the dependencies are not installed: the check fails instead.
 * `--` ends npx's own options: without it npx takes `-f` for itself, and ESLint gets `json` as a file.
 */
export const ESLINT_COMMAND = `npx --no -- eslint -f json -o ${ESLINT_REPORT} .`
