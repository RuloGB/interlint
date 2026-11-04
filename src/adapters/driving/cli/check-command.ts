import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { type CheckProjectDeps, checkProject } from "../../../application/checking/check-project.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"
import { projectFiles } from "./project-paths.js"

export async function check(args: string[], io: Io, deps: CheckProjectDeps): Promise<number> {
  const { values } = parseCheckArgs(args)
  const when = values.when ?? "task-end"
  const files = values.file ?? []
  if (when !== "edit" && when !== "task-end") throw new UsageError(`--when must be edit or task-end (got "${when}")`)
  if (when === "edit" && files.length === 0) throw new UsageError("--when edit needs at least one --file <path>")
  if (when === "edit" && values.changed === true) throw new UsageError("--changed is only valid with --when task-end")
  const lines = parseLines(values.lines, files.length, when)

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const { report, notice, passed } =
    when === "edit"
      ? await checkProject(
          projectDir,
          {
            when: "edit",
            files: projectFiles(io.cwd, projectDir, files),
            linesWritten: linesByFile(io.cwd, projectDir, files, lines),
          },
          deps,
        )
      : await checkProject(
          projectDir,
          {
            when: "task-end",
            // Files given but all outside the project hold no project, so nothing runs for them.
            files: files.length > 0 ? projectFiles(io.cwd, projectDir, files) : undefined,
            changedOnly: values.changed === true,
          },
          deps,
        )
  // The notice comes after the report, so output that starts with a failure still means a failure. The checks that
  // passed come last, so output that starts with a notice still means a notice.
  const output = [report, notice, passed].filter((text) => text !== "").join("\n")
  if (output !== "") io.stdout(output)
  return report === "" ? EXIT.passed : EXIT.violations
}

/**
 * The `--lines` values, one for each `--file` in the same place: the lines the edit wrote in that file. None given,
 * the files wrote no lines.
 */
function parseLines(values: string[] | undefined, files: number, when: string): number[] {
  if (values === undefined) return []
  if (when !== "edit") throw new UsageError("--lines is only valid with --when edit")
  if (values.length !== files) {
    throw new UsageError(`--lines needs one value for each --file (got ${values.length} --lines for ${files} --file)`)
  }
  return values.map((value) => {
    if (!/^\d+$/.test(value)) throw new UsageError(`--lines must be a whole number of 0 or more (got "${value}")`)
    return Number(value)
  })
}

/** The lines written in each file, by its path relative to the project. Files outside it are left out. */
function linesByFile(cwd: string, projectDir: string, files: string[], lines: number[]): Map<string, number> {
  const written = new Map<string, number>()
  files.forEach((file, index) => {
    const [path] = projectFiles(cwd, projectDir, [file])
    if (path !== undefined) written.set(path, (written.get(path) ?? 0) + (lines[index] ?? 0))
  })
  return written
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        when: { type: "string" },
        cwd: { type: "string" },
        file: { type: "string", multiple: true },
        lines: { type: "string", multiple: true },
        changed: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
