import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { ProjectLock } from "../../../application/checking/ports.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"

/** What `interlint lock` writes once it holds the lock, so its caller knows its build may start. */
export const LOCKED = "locked"

/**
 * Holds the project lock for a build the agent runs itself, so it never shares `target/` with Interlint's checks.
 * Internal, for the OpenCode plugin, and left out of the usage like `--agent-context`. It waits for the checks that
 * hold the lock, writes `locked`, and holds the lock until its stdin closes. A caller that dies closes it too.
 */
export async function lock(args: string[], io: Io, projectLock: ProjectLock): Promise<number> {
  const { values } = parseLockArgs(args)
  const stdin = io.stdin
  if (stdin === undefined) throw new UsageError("lock holds the project lock until its stdin closes, and has none")
  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  await projectLock(projectDir, async () => {
    io.stdout(`${LOCKED}\n`)
    await stdin()
  })
  return EXIT.passed
}

function parseLockArgs(args: string[]) {
  try {
    return parseArgs({ args, options: { cwd: { type: "string" } }, strict: true, allowPositionals: false })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
