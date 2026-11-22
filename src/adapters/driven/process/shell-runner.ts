import { spawn } from "node:child_process"
import type { ShellCommand, ShellRunner } from "../../../application/checking/ports.js"
import { hasExecutable } from "./executable-lookup.js"

/** The signals that stop Interlint, passed on to the agent's command so it never runs on without the lock. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * Runs a PowerShell command as Copilot's shell would, and ends with the exit code of the last program it ran, as
 * Copilot reports it: PowerShell itself exits 1 for any failure, so `mvn` failing with 3 would read as 1. The code is
 * set with `SetShouldExit`, which lets the script end normally: `exit` would drop a table not printed yet. Progress
 * records, such as PowerShell preparing its modules, are left out: they are no output of the command.
 */
export function powershellScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    command,
    "$interlintOk = $?",
    "if ($LASTEXITCODE) { $host.SetShouldExit($LASTEXITCODE) } elseif (-not $interlintOk) { $host.SetShouldExit(1) }",
  ].join("\n")
}

/**
 * The program and arguments that run `command` as its shell would. PowerShell gets it encoded, so no quoting of the
 * Windows command line can change it.
 */
export function shellInvocation(command: ShellCommand, has: (name: string) => boolean = hasExecutable): { file: string; args: string[] } {
  if (command.shell === "bash") return { file: command.executable ?? "bash", args: ["-c", command.text] }
  const file = command.executable ?? (has("pwsh") ? "pwsh" : "powershell")
  const encoded = Buffer.from(powershellScript(command.text), "utf16le").toString("base64")
  return { file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] }
}

/** Runs an agent's shell command in the current directory, its output going straight to Interlint's own. */
export const runShell: ShellRunner = (command) =>
  new Promise((done) => {
    const { file, args } = shellInvocation(command)
    const child = spawn(file, args, { stdio: "inherit", windowsHide: true })
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    for (const signal of STOP_SIGNALS) process.on(signal, forward)
    const finish = (exitCode: number) => {
      for (const signal of STOP_SIGNALS) process.off(signal, forward)
      done(exitCode)
    }
    child.on("error", (error) => {
      process.stderr.write(`interlint: could not start ${file}: ${error.message}\n`)
      finish(127)
    })
    child.on("close", (code) => finish(code ?? 1))
  })
