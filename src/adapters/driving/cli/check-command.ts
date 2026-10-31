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

  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  const output =
    when === "edit"
      ? await checkProject(projectDir, { when: "edit", files: projectFiles(io.cwd, projectDir, files) }, deps)
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
  if (output === "") return EXIT.passed
  io.stdout(output)
  return EXIT.violations
}

function parseCheckArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        when: { type: "string" },
        cwd: { type: "string" },
        file: { type: "string", multiple: true },
        changed: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
