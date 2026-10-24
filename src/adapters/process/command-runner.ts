import { spawn } from "node:child_process"
import type { CommandRunner } from "../../core/ports.js"

/** Keeps memory bounded on chatty builds; only the end of the output is ever shown. */
const MAX_OUTPUT_CHARS = 64 * 1024

/**
 * `interlint.yaml` is shared across operating systems, but cmd.exe does not run `./mvnw`.
 * On Windows a leading `./` becomes `.\`, which finds `mvnw.cmd`.
 */
export function toPlatformCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? command.replace(/^\.\//, ".\\") : command
}

/** Runs a check's `run` command through the shell, as the team would type it. */
export const runCommand: CommandRunner = (command, cwd) =>
  new Promise((resolve) => {
    let output = ""
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS)
    }
    // windowsHide: a parent without a console, such as an agent's desktop app, would otherwise get a console window.
    const child = spawn(toPlatformCommand(command), {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => resolve({ exitCode: 127, output: `${output}${error.message}\n` }))
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output }))
  })
