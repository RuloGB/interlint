/**
 * Where a dependency-cruiser check writes its JSON report, `/`-separated and relative to its project. The reader is
 * not told the command, so the path is fixed. dependency-cruiser does not create its directory: the reader does.
 */
export const DEPCRUISE_REPORT = "node_modules/.cache/interlint/depcruise.json"

/**
 * The project's own dependency-cruiser on the whole project, with its report where the reader looks for it. It runs
 * on the whole project at edit too: given only the edited file, rules about who imports a module, such as
 * `no-orphans`, report files that are fine. `--no` keeps npx from downloading it when the dependencies are not
 * installed, and `--` ends npx's own options.
 */
export const DEPCRUISE_COMMAND = `npx --no -- depcruise . -T json --output-to ${DEPCRUISE_REPORT}`
