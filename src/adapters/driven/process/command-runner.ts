import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, extname, resolve } from "node:path"
import type { CommandResult, CommandRunner } from "../../../application/checking/ports.js"

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

/** A POSIX shell's own commands, and its keywords, which are no file to find. */
const SH_BUILTINS = new Set(
  [
    ".", ":", "[", "alias", "break", "case", "cd", "command", "continue", "echo", "eval", "exec", "exit", "export",
    "false", "for", "if", "printf", "pwd", "read", "return", "set", "shift", "source", "test", "time", "times", "trap",
    "true", "type", "ulimit", "umask", "unalias", "unset", "until", "wait", "while", "{", "(", "!",
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
 * `cwd` or on the PATH, with a PATHEXT extension. A first word it cannot tell, such as one with `%VAR%`, counts as found.
 */
export function cmdFindsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = firstWord(command)
  if (name === undefined || name.includes("%") || CMD_BUILTINS.has(name.toLowerCase())) return true
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean).map((ext) => ext.toLowerCase())
  const files = extensions.includes(extname(name).toLowerCase()) ? [name] : extensions.map((ext) => name + ext)
  const dirs = /[\\/:]/.test(name) ? [cwd] : [cwd, ...pathDirs(env)]
  return dirs.some((dir) => files.some((file) => isFile(resolve(dir, file))))
}

/**
 * Whether a POSIX shell finds what `command` starts with: one of its own commands, an executable file it names from
 * `cwd`, or one on the PATH. A first word it cannot tell, such as a variable or an assignment, counts as found.
 */
export function shFindsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = firstWord(command)
  if (name === undefined || /[$=`~]/.test(name) || SH_BUILTINS.has(name)) return true
  const dirs = name.includes("/") ? [cwd] : pathDirs(env)
  return dirs.some((dir) => isExecutable(resolve(dir, name)))
}

/**
 * Whether a command that exited with `exitCode` never ran: the shell could not find or start what it starts with.
 * A command that started and passed on such a code from a tool it ran, as `npm test` does without its test runner,
 * did run: its first word is found.
 */
export function didNotStart(
  command: string,
  cwd: string,
  exitCode: number,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Run with `/c`, cmd.exe exits 1 for a command it does not recognize, the same as one that ran and failed.
  if (platform === "win32") return exitCode === 1 && !cmdFindsCommand(command, cwd, env)
  return POSIX_NOT_STARTED.includes(exitCode) && !shFindsCommand(command, cwd, env)
}

/** Runs a check's `run` command through the shell, as the team would type it. */
export const runCommand: CommandRunner = (command, cwd) =>
  new Promise((done) => {
    let output = ""
    let droppedLines = 0
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      const extra = output.length - MAX_OUTPUT_CHARS
      if (extra <= 0) return
      droppedLines += output.slice(0, extra).split("\n").length - 1
      output = output.slice(extra)
    }
    const result = (exitCode: number, notFound: boolean): CommandResult => ({
      exitCode,
      output,
      ...(notFound ? { notFound: true } : {}),
      ...(droppedLines > 0 ? { droppedLines } : {}),
    })
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
    child.on("error", (error) => {
      output += `${error.message}\n`
      done(result(127, true))
    })
    child.on("close", (code) => {
      const exitCode = code ?? 1
      done(result(exitCode, didNotStart(platformCommand, cwd, exitCode)))
    })
  })

/** The program a command starts with, without the quotes around it. */
function firstWord(command: string): string | undefined {
  return /^\s*(?:"([^"]+)"|'([^']+)'|([^\s&|;<>()]+))/.exec(command)?.slice(1).find((part) => part !== undefined)
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  if (!isFile(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Whether the shell `runCommand` uses finds the program `command` starts with, from `cwd`. */
export function findsCommand(command: string, cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  const platformCommand = toPlatformCommand(command, platform)
  return platform === "win32" ? cmdFindsCommand(platformCommand, cwd) : shFindsCommand(platformCommand, cwd)
}
