import { describe, expect, it } from "vitest"
import { runAgentBuild, type AgentBuildDeps } from "../src/application/checking/agent-build.js"
import type { ShellCommand } from "../src/application/checking/ports.js"
import { onlyMaven, runsMaven, startsServer } from "../src/domain/agent-build.js"

/** A lock that logs when it is taken and released, a clock the test moves, and a shell that logs when it runs. */
function fakeDeps(options: { waitMs?: number; exitCode?: number } = {}) {
  const log: string[] = []
  let now = 0
  const deps: AgentBuildDeps = {
    now: () => now,
    lock: async (_projectDir, work) => {
      now += options.waitMs ?? 0
      log.push("locked")
      try {
        return await work()
      } finally {
        log.push("released")
      }
    },
    runShell: async (command) => {
      log.push(`ran ${command.text}`)
      return options.exitCode ?? 0
    },
  }
  return { deps, log }
}

const command = (text: string): ShellCommand => ({ shell: "powershell", text })

describe("runAgentBuild", () => {
  it("runs the agent's build while it holds the project lock, and gives its exit code", async () => {
    const { deps, log } = fakeDeps({ exitCode: 3 })
    const notes: string[] = []

    expect(await runAgentBuild("/project", command("mvn test"), deps, (note) => notes.push(note))).toBe(3)
    expect(log).toEqual(["locked", "ran mvn test", "released"])
    expect(notes).toEqual([])
  })

  it("tells a build that waited 1 s or more for the checks, before it runs", async () => {
    const { deps, log } = fakeDeps({ waitMs: 4200 })

    await runAgentBuild("/project", command("mvn test"), deps, (note) => log.push(note))

    expect(log).toEqual([
      "locked",
      "Interlint: this command waited 4 s for Interlint's checks on this project to finish, so the two builds did not share target/.",
      "ran mvn test",
      "released",
    ])
  })

  it("says nothing of a wait under 1 s", async () => {
    const { deps } = fakeDeps({ waitMs: 999 })
    const notes: string[] = []

    await runAgentBuild("/project", command("mvn test"), deps, (note) => notes.push(note))

    expect(notes).toEqual([])
  })

  it("lets a server wait for the checks and run without the lock, as it never ends", async () => {
    const { deps, log } = fakeDeps()

    await runAgentBuild("/project", command("./mvnw spring-boot:run"), deps, () => {})

    expect(log).toEqual(["locked", "released", "ran ./mvnw spring-boot:run"])
  })
})

describe("runsMaven", () => {
  it.each(["mvn test", "cd orders && ./mvnw -q test", "& .\\mvnw.cmd verify", "mvnd package", "(mvn test)", "C:\\tools\\mvn.bat -v"])(
    "finds Maven in %s",
    (line) => expect(runsMaven(line)).toBe(true),
  )

  it.each(["git status", "cat mvnw.properties", "echo mvnwrapper", "ls .mvn"])("finds no Maven in %s", (line) =>
    expect(runsMaven(line)).toBe(false),
  )
})

describe("startsServer", () => {
  it.each(["mvn spring-boot:run", "./mvnw quarkus:dev -pl api", "mvn jetty:run"])("tells %s starts a server", (line) =>
    expect(startsServer(line)).toBe(true),
  )

  it.each(["mvn test", "mvn exec:java", "mvn verify -Drun=1"])("tells %s starts none", (line) => expect(startsServer(line)).toBe(false))
})

describe("onlyMaven", () => {
  it.each([
    "mvn test",
    "./mvnw -q verify -pl api -am",
    "mvnd package -DskipTests",
    "& .\\mvnw.cmd test",
    ".\\mvnw.cmd -Dtest=OrderTest test",
    "cd orders && ./mvnw test",
    "cd orders; mvn verify",
    "cd 'my project' && mvn test",
    "mvn test -Dmsg=\"two words\"",
  ])("finds only Maven in %s", (line) => expect(onlyMaven(line)).toBe(true))

  it.each([
    "mvn test && git push",
    "mvn test; rm -rf target",
    "rm -rf target; mvn test",
    "mvn test | tail -20",
    "mvn test 2>&1",
    "mvn test > build.log",
    "mvn test &",
    "mvn test -Dv=$(git push)",
    "mvn test -Dv=`git push`",
    "mvn test -Dv=\"$(git push)\"",
    "mvn test | Where-Object { $_ }",
    "mvn test\ngit push",
    "cd $(git push) && mvn test",
    "JAVA_HOME=/opt/jdk mvn test",
  ])("finds more than Maven in %s", (line) => expect(onlyMaven(line)).toBe(false))
})
