import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lockFileFor } from "../src/adapters/driven/state/project-lock.js"
import { lockedShellCommand } from "../src/adapters/driving/copilot/shell-wrap.js"

/** The built CLI. Reads `dist/` as it is, so build first. */
const CLI = join(import.meta.dirname, "..", "dist", "main.js")
const SHELL = process.platform === "win32" ? "powershell" : "bash"

let projectDir: string
let binDir: string

beforeEach(() => {
  // A quote and a space in the path, which both shells quote differently.
  projectDir = mkdtempSync(join(tmpdir(), "interlint it's-"))
  // `interlint` on the PATH, as npm installs it: a `.cmd` shim on Windows, an executable script elsewhere.
  binDir = mkdtempSync(join(tmpdir(), "interlint-bin-"))
  if (process.platform === "win32") {
    writeFileSync(join(binDir, "interlint.cmd"), `@"${process.execPath}" "${CLI}" %*\r\n`)
  } else {
    writeFileSync(join(binDir, "interlint"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
    chmodSync(join(binDir, "interlint"), 0o755)
  }
})

afterEach(() => {
  for (const dir of [projectDir, binDir]) rmSync(dir, { recursive: true, force: true })
})

/**
 * Runs a command line in the agent's shell, from the project, as Copilot's shell tool does. In PowerShell the exit
 * code is `$LASTEXITCODE`, which Copilot reports: PowerShell itself would exit 1.
 */
function inShell(command: string) {
  const script = `${command}\nexit $LASTEXITCODE`
  const args =
    SHELL === "powershell"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
      : ["-c", command]
  const PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`
  return spawnSync(SHELL, args, { cwd: projectDir, encoding: "utf8", windowsHide: true, env: { ...process.env, PATH, Path: PATH } })
}

describe("the command Copilot's pre-shell hook wraps a build in", () => {
  it("runs the original command in the agent's shell and directory, under the lock, and passes on its exit code", () => {
    const lockFile = JSON.stringify(lockFileFor(projectDir)).replace(/"/g, "'")
    const original = `node -e "const fs = require('fs'); fs.writeFileSync('out.txt', String(fs.existsSync(${lockFile}))); process.exit(3)"`

    const result = inShell(lockedShellCommand({ tool: SHELL, command: original, args: {} }, projectDir))

    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("")
    expect(result.status).toBe(3)
    expect(readFileSync(join(projectDir, "out.txt"), "utf8")).toBe("true")
    expect(existsSync(lockFileFor(projectDir))).toBe(false)
  })
})

describe("the wrapped command in PowerShell", () => {
  it.runIf(process.platform === "win32")("prints a table the command writes after a program that fails, as PowerShell would", () => {
    writeFileSync(join(projectDir, "marker.txt"), "")
    const original = `node -e "process.exit(3)"; Get-Item marker.txt | Select-Object Name`

    const result = inShell(lockedShellCommand({ tool: "powershell", command: original, args: {} }, projectDir))

    expect(result.status).toBe(3)
    expect(result.stdout).toContain("marker.txt")
    expect(result.stderr).toBe("")
  })
})
