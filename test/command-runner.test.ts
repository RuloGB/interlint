import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cmdFindsCommand, toPlatformCommand } from "../src/adapters/driven/process/command-runner.js"

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

describe("cmdFindsCommand", () => {
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
