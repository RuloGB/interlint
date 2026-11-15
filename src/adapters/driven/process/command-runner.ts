import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import { delimiter, extname, resolve } from "node:path"
import type { CommandRunner } from "../../../application/checking/ports.js"

/** Keeps memory bounded on chatty builds; only the end of the output is ever shown. */
const MAX_OUTPUT_CHARS = 64 * 1024

/** The exit codes a POSIX shell gives a command it cannot run (126) or cannot find (127). */
const POSIX_NOT_STARTED = [126, 127]

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/** cmd.exe's own commands, which are no file to find. */
const CMD_BUILTINS = new Set(
  [
    "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal", "erase",
    "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "prompt", "pushd",
    "rd", "rem", "ren", "rename", "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver",
    "verify", "vol",
  ],
)

/**
 * `interlint.yaml` is shared across operating systems, but cmd.exe does not run `./mvnw`.
 * On Windows a leading `./` becomes `.\`, which finds `mvnw.cmd`.
 */
export function toPlatformCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? command.replace(/^\.\//, ".\\") : command
}

/**
 * Whether cmd.exe finds what `command` starts with: one of its own commands, a file it names from `cwd`, or a file in
 * `cwd` or on the PATH, with a PATHEXT extension.
 */
export function cmdFindsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = /^\s*(?:"([^"]+)"|([^\s&|<>()]+))/.exec(command)?.slice(1).find((part) => part !== undefined)
  if (name === undefined || CMD_BUILTINS.has(name.toLowerCase())) return true
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean).map((ext) => ext.toLowerCase())
  const files = extensions.includes(extname(name).toLowerCase()) ? [name] : extensions.map((ext) => name + ext)
  const dirs = /[\\/:]/.test(name) ? [cwd] : [cwd, ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)]
  return dirs.some((dir) => files.some((file) => isFile(resolve(dir, file))))
}

/** Runs a check's `run` command through the shell, as the team would type it. */
export const runCommand: CommandRunner = (command, cwd) =>
  new Promise((done) => {
    let output = ""
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS)
    }
    const platformCommand = toPlatformCommand(command)
    // windowsHide: a parent without a console, such as an agent's desktop app, would otherwise get a console window.
    const child = spawn(platformCommand, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => done({ exitCode: 127, output: `${output}${error.message}\n`, notFound: true }))
    child.on("close", (code) => {
      const exitCode = code ?? 1
      // Run with `/c`, cmd.exe exits 1 for a command it does not recognize, the same as one that ran and failed.
      const notFound =
        process.platform === "win32"
          ? exitCode === 1 && !cmdFindsCommand(platformCommand, cwd)
          : POSIX_NOT_STARTED.includes(exitCode)
      done(notFound ? { exitCode, output, notFound: true } : { exitCode, output })
    })
  })

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
