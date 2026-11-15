import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cmdFindsCommand, runCommand, shFindsCommand, toPlatformCommand } from "../src/adapters/driven/process/command-runner.js"

describe("toPlatformCommand", () => {
  it("turns a leading ./ into .\\ on Windows, so cmd.exe finds mvnw.cmd", () => {
    expect(toPlatformCommand("./mvnw -q test -Dtest=ArchitectureRulesTest", "win32")).toBe(
      ".\\mvnw -q test -Dtest=ArchitectureRulesTest",
    )
  })

  it("leaves ./ inside the arguments alone", () => {
    expect(toPlatformCommand("mvnd -f ./pom.xml test", "win32")).toBe("mvnd -f ./pom.xml test")
  })

  it("leaves the command alone on other platforms", () => {
    expect(toPlatformCommand("./mvnw test", "linux")).toBe("./mvnw test")
  })
})

// cmd.exe rules: Windows paths, case-insensitive files. Interlint looks commands up this way only on Windows.
describe.runIf(process.platform === "win32")("cmdFindsCommand", () => {
  let cwd: string
  let bin: string
  const env = () => ({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" })

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "interlint-cmd-"))
    bin = join(cwd, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "npm.cmd"), "")
    writeFileSync(join(cwd, "mvnw.cmd"), "")
    writeFileSync(join(cwd, "script.sh"), "")
  })

  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it.each(["npm test", "NPM.CMD test", "mvnw test", ".\\mvnw test", "cd web && npm test", "echo ok", "\"npm\" test"])(
    "finds %s",
    (command) => {
      expect(cmdFindsCommand(command, cwd, env())).toBe(true)
    },
  )

  it.each(["vitest run", "interlint-no-such-command-f24", ".\\gradlew build", "script.sh"])("does not find %s", (command) => {
    expect(cmdFindsCommand(command, cwd, env())).toBe(false)
  })
})

// POSIX rules: executable files only, case-sensitive. Interlint looks commands up this way only off Windows.
describe.runIf(process.platform !== "win32")("shFindsCommand", () => {
  let cwd: string
  let bin: string
  const env = () => ({ PATH: bin })

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "interlint-sh-"))
    bin = join(cwd, "bin")
    mkdirSync(bin)
    for (const [file, mode] of [[join(bin, "npm"), 0o755], [join(cwd, "run.sh"), 0o755], [join(cwd, "plain.sh"), 0o644]] as const) {
      writeFileSync(file, "")
      chmodSync(file, mode)
    }
  })

  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it.each(["npm test", "./run.sh", "cd web && npm test", "echo ok", "FOO=1 vitest run", "$RUNNER test", "'npm' test"])(
    "finds %s",
    (command) => {
      expect(shFindsCommand(command, cwd, env())).toBe(true)
    },
  )

  it.each(["vitest run", "interlint-no-such-command-f24", "./plain.sh", "./gradlew build", "NPM test"])("does not find %s", (command) => {
    expect(shFindsCommand(command, cwd, env())).toBe(false)
  })
})

describe("runCommand", () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "interlint-run-"))
  })

  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it("counts the lines it leaves out to keep the output bounded", async () => {
    writeFileSync(join(cwd, "chatty.mjs"), 'for (let i = 1; i <= 20000; i++) console.log(`line ${i}`)\n')

    const { exitCode, output, droppedLines = 0 } = await runCommand("node chatty.mjs", cwd)

    const kept = output.trimEnd().split(/\r?\n/)
    expect(exitCode).toBe(0)
    expect(droppedLines).toBeGreaterThan(0)
    expect(kept.at(-1)).toBe("line 20000")
    expect(droppedLines + kept.length).toBe(20000)
  })

  it("does not take a command that started and exited 127 for one that was not found", async () => {
    writeFileSync(join(cwd, "nested.mjs"), "process.exit(127)\n")

    expect(await runCommand("node nested.mjs", cwd)).toEqual({ exitCode: 127, output: "" })
  })

  it("marks a command that does not exist as not found", async () => {
    expect(await runCommand("interlint-no-such-command-f24", cwd)).toMatchObject({ notFound: true })
  })
})
