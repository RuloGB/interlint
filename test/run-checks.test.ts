import { describe, expect, it } from "vitest"
import type { Check } from "../src/core/check.js"
import { usesMaven, withMavenDaemon } from "../src/core/maven.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/core/run-checks.js"

const PASSING_READER = { snapshot: () => new Map(), read: () => ({ found: true, failures: [] }) }

/** Fake adapters that record the commands they are asked to run. */
function fakeDeps(options: { mvnd: boolean }) {
  const launched: string[] = []
  const deps: CheckDeps = {
    run: async (command) => {
      launched.push(command)
      return { exitCode: 0, output: "" }
    },
    readers: { archunit: PASSING_READER },
    hasExecutable: (name) => options.mvnd && name === "mvnd",
  }
  return { deps, launched }
}

function config(...checks: Check[]) {
  return { checks }
}

const mavenEdit: Check = { name: "architecture", run: "./mvnw -q test -Dtest=ArchitectureRulesTest", report: "archunit", when: "edit" }
const scriptEdit: Check = { name: "fast", run: "node fast.mjs", report: "archunit", when: "edit" }
const scriptTaskEnd: Check = { name: "slow", run: "node slow.mjs", report: "archunit", when: "task-end" }

describe("usesMaven", () => {
  it.each(["./mvnw -q test", ".\\mvnw.cmd test", "mvnw test", "mvn verify", "mvn.cmd verify", "mvnd test", "  mvn test"])(
    "detects %s",
    (command) => {
      expect(usesMaven(command)).toBe(true)
    },
  )

  it.each(["node check.mjs", "cd api && ./mvnw test", "mvnwrapper test", "gradle test"])("does not detect %s", (command) => {
    expect(usesMaven(command)).toBe(false)
  })
})

describe("withMavenDaemon", () => {
  it("replaces only the executable and keeps the arguments", () => {
    expect(withMavenDaemon("./mvnw -q test -Dtest=ArchitectureRulesTest")).toBe("mvnd -q test -Dtest=ArchitectureRulesTest")
    expect(withMavenDaemon(".\\mvnw.cmd test")).toBe("mvnd test")
    expect(withMavenDaemon("mvn verify")).toBe("mvnd verify")
    expect(withMavenDaemon("mvnd test")).toBe("mvnd test")
  })
})

describe("runEditChecks", () => {
  it("runs only the edit checks when a Java source changed", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })

    const outcomes = await runEditChecks("/repo", config(scriptEdit, scriptTaskEnd), ["src/main/java/shop/Order.java"], deps)

    expect(launched).toEqual(["node fast.mjs"])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
  })

  it("runs nothing when no changed file is a source of the check", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })

    expect(await runEditChecks("/repo", config(scriptEdit, mavenEdit), ["README.md", "pom.xml"], deps)).toEqual([])
    expect(launched).toEqual([])
  })

  it("leaves a Maven edit check for task end when mvnd is not on the PATH", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })

    expect(await runEditChecks("/repo", config(mavenEdit, scriptEdit), ["src/main/java/shop/Order.java"], deps)).toHaveLength(1)
    expect(launched).toEqual(["node fast.mjs"])
  })

  it("runs a Maven edit check with mvnd when it is on the PATH", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })

    await runEditChecks("/repo", config(mavenEdit), ["src/main/java/shop/Order.java"], deps)

    expect(launched).toEqual(["mvnd -q test -Dtest=ArchitectureRulesTest"])
  })
})

describe("runTaskEndChecks", () => {
  it("runs a Maven edit check as written when mvnd is not on the PATH", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })

    await runTaskEndChecks("/repo", config(mavenEdit, scriptTaskEnd), deps)

    expect(launched).toEqual(["./mvnw -q test -Dtest=ArchitectureRulesTest", "node slow.mjs"])
  })

  it("runs Maven checks with mvnd when it is on the PATH", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })

    await runTaskEndChecks("/repo", config(mavenEdit, scriptTaskEnd), deps)

    expect(launched).toEqual(["mvnd -q test -Dtest=ArchitectureRulesTest", "node slow.mjs"])
  })

  it("shows the command it actually launched when a check fails", async () => {
    const { deps } = fakeDeps({ mvnd: true })
    deps.run = async () => ({ exitCode: 1, output: "[ERROR] COMPILATION ERROR" })
    deps.readers = { archunit: { ...PASSING_READER, read: () => ({ found: false, failures: [] }) } }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "failed", command: "mvnd -q test -Dtest=ArchitectureRulesTest" })
  })
})
