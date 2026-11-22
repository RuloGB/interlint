import type { CopilotShellCall } from "./hook-input.js"

/** The program the wrapped command runs, found on the shell's PATH. */
export const INTERLINT_PROGRAM = "interlint"

/**
 * Interlint as each shell finds it on the PATH, by name. A path outside the project, such as Interlint's own script,
 * makes Copilot ask the user to approve the command, and deny it when nobody can answer. PowerShell takes the first
 * program, such as npm's `.cmd` shim or an `.exe`, and never npm's `.ps1` shim, which an execution policy may block.
 * Looking it up may make PowerShell prepare its modules, whose progress record the agent would read: it is left out.
 * Each call of Copilot's shell tool starts a new shell, so the setting does not outlast the command.
 */
const INTERLINT = {
  powershell: `$ProgressPreference = 'SilentlyContinue'; & (Get-Command ${INTERLINT_PROGRAM} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`,
  bash: INTERLINT_PROGRAM,
} as const

/**
 * The executable of the PowerShell that runs the wrapped command, `pwsh` or Windows PowerShell. Through .NET, as
 * `Get-Process` may load its module first and write a progress record the agent would read.
 */
const CURRENT_POWERSHELL = "([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)"

/** The quotes that end a PowerShell single-quoted string: the ASCII one and the typographic ones PowerShell also accepts. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g

/**
 * The command that runs `call`'s command under `interlint lock --command`, which holds the project lock while it runs.
 * The original goes in base64, so no quoting of either shell can change it, and it runs in the same shell executable.
 */
export function lockedShellCommand(call: CopilotShellCall, projectDir: string): string {
  const encoded = Buffer.from(call.command, "utf8").toString("base64")
  if (call.tool === "powershell") {
    const quote = (text: string) => `'${text.replace(POWERSHELL_QUOTES, "$&$&")}'`
    return `${INTERLINT.powershell} lock --cwd ${quote(projectDir)} --shell powershell --shell-path ${CURRENT_POWERSHELL} --command ${encoded}`
  }
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`
  return `${INTERLINT.bash} lock --cwd ${quote(projectDir)} --shell bash --shell-path "$BASH" --command ${encoded}`
}
