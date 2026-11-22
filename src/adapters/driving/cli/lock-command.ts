import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { type AgentBuildDeps, runAgentBuild } from "../../../application/checking/agent-build.js"
import type { ShellCommand } from "../../../application/checking/ports.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"

/** What `interlint lock` writes once it holds the lock, so its caller knows its build may start. */
export const LOCKED = "locked"

const SHELLS: readonly ShellCommand["shell"][] = ["powershell", "bash"]

/**
 * Holds the project lock for a build the agent runs itself, so it never shares `target/` with Interlint's checks.
 * Internal, and left out of the usage like `--agent-context`.
 *
 * Without `--command`, for the OpenCode plugin: it waits for the checks that hold the lock, writes `locked`, and holds
 * the lock until its stdin closes. A caller that dies closes it too.
 *
 * With `--command`, for the agents whose hooks are short processes: it runs the agent's command, given in base64, in
 * its `--shell` while it holds the lock, and exits with the command's exit code. The command is the lock's holder, so
 * the lock lasts exactly as long as it runs, also in the background.
 */
export async function lock(args: string[], io: Io, deps: AgentBuildDeps): Promise<number> {
  const { values } = parseLockArgs(args)
  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  if (values.command !== undefined) return runCommand(projectDir, values, io, deps)
  if (values.shell !== undefined || values["shell-path"] !== undefined) throw new UsageError("--shell and --shell-path go with --command")
  const stdin = io.stdin
  if (stdin === undefined) throw new UsageError("lock holds the project lock until its stdin closes, and has none")
  await deps.lock(projectDir, async () => {
    io.stdout(`${LOCKED}\n`)
    await stdin()
  })
  return EXIT.passed
}

function runCommand(projectDir: string, values: ReturnType<typeof parseLockArgs>["values"], io: Io, deps: AgentBuildDeps): Promise<number> {
  const { shell, command } = values
  if (!(SHELLS as readonly (string | undefined)[]).includes(shell)) throw new UsageError(`--command needs --shell ${SHELLS.join(" or ")}`)
  const text = Buffer.from(command ?? "", "base64").toString("utf8")
  if (text.trim() === "") throw new UsageError("--command must be a command line in base64")
  const executable = values["shell-path"]
  const shellCommand: ShellCommand = { shell: shell as ShellCommand["shell"], text, ...(executable ? { executable } : {}) }
  return runAgentBuild(projectDir, shellCommand, deps, (note) => io.stdout(`${note}\n`))
}

function parseLockArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { cwd: { type: "string" }, command: { type: "string" }, shell: { type: "string" }, "shell-path": { type: "string" } },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
