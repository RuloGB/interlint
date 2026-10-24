import { describe, expect, it } from "vitest"
import { toPlatformCommand } from "../src/adapters/process/command-runner.js"

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
