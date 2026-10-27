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
    readers: { archunit: PASSING_READER, maven: PASSING_READER },
    hasExecutable: (name) => options.mvnd && name === "mvnd",
    lock: (_projectDir, work) => work(),
    changes: { lookup: () => ({ changed: true, record: undefined, fingerprint: "" }), accept: () => {}, touch: () => {} },
    hasDirectory: () => true,
    editScopes: {},
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
    deps.readers = { ...deps.readers, archunit: { ...PASSING_READER, read: () => ({ found: false, failures: [] }) } }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "failed", command: "mvnd -q test -Dtest=ArchitectureRulesTest" })
  })
})

describe("checks of several projects", () => {
  const orders: Check = { name: "orders/architecture", dir: "orders", run: "./mvnw -q test", report: "archunit", when: "edit" }
  const billing: Check = { name: "billing/architecture", dir: "apps/billing", run: "./mvnw -q test", report: "archunit", when: "edit" }
  const violation = { text: "Order calls OrderEntity", file: "Order.java", line: 3, path: "domain/src/main/java/shop/Order.java" }

  function recordingDeps() {
    const { deps } = fakeDeps({ mvnd: false })
    const ran: string[] = []
    const read: string[] = []
    deps.run = async (_command, cwd) => (ran.push(cwd), { exitCode: 1, output: "" })
    deps.readers = {
      ...deps.readers,
      archunit: {
        snapshot: () => new Map(),
        read: (dir) => (read.push(dir), { found: true, failures: [{ title: "ARCH-01", violations: [{ ...violation }] }] }),
      },
    }
    return { deps, ran, read }
  }

  it("runs each check in its own directory and reads its reports there", async () => {
    const { deps, ran, read } = recordingDeps()

    await runTaskEndChecks("/ws", config(orders, billing), deps)

    expect(ran).toEqual(["/ws/orders", "/ws/apps/billing"])
    expect(read).toEqual(ran)
  })

  it("gives each violation its path from the directory Interlint started in", async () => {
    const { deps } = recordingDeps()

    const [outcome] = await runTaskEndChecks("/ws", config(orders), deps)

    expect(outcome).toMatchObject({
      status: "violations",
      failures: [{ violations: [{ ...violation, path: "orders/domain/src/main/java/shop/Order.java" }] }],
    })
  })

  it("runs at edit only the checks of the project the file belongs to", async () => {
    const { deps, ran } = recordingDeps()
    deps.hasExecutable = () => true

    await runEditChecks("/ws", config(orders, billing), ["apps/billing/core/src/main/java/shop/Invoice.java"], deps)

    expect(ran).toEqual(["/ws/apps/billing"])
  })

  it("runs nothing at edit for a file outside every check's project", async () => {
    const { deps, ran } = recordingDeps()
    deps.hasExecutable = () => true

    expect(await runEditChecks("/ws", config(orders, billing), ["web/src/App.java", "ordersx/A.java"], deps)).toEqual([])
    expect(ran).toEqual([])
  })
})

describe("only the projects that changed", () => {
  const orders: Check = { name: "orders/architecture", dir: "orders", run: "orders arch", report: "archunit", when: "edit" }
  const ordersStyle: Check = { name: "orders/checkstyle", dir: "orders", run: "orders style", report: "maven", when: "task-end" }
  const billing: Check = { name: "billing/architecture", dir: "billing", run: "billing arch", report: "archunit", when: "edit" }

  function trackingDeps(changed: string[], failing: string[] = []) {
    const { deps, launched } = fakeDeps({ mvnd: false })
    const accepted: string[] = []
    const touched: string[] = []
    deps.run = async (command) => (launched.push(command), { exitCode: failing.includes(command) ? 1 : 0, output: "" })
    deps.changes = {
      lookup: (dir) => ({ changed: changed.includes(dir), record: `record of ${dir}`, fingerprint: "" }),
      accept: (dir, seen) => void accepted.push(seen.record === `record of ${dir}` ? dir : `${dir} (wrong record)`),
      touch: (dir) => void touched.push(dir),
    }
    return { deps, launched, accepted, touched }
  }

  it("runs at task end only the checks of the projects that changed", async () => {
    const { deps, launched } = trackingDeps(["/ws/billing"])

    await runTaskEndChecks("/ws", config(orders, ordersStyle, billing), deps, { changedOnly: true })

    expect(launched).toEqual(["billing arch"])
  })

  it("runs nothing at task end when no project changed", async () => {
    const { deps, launched } = trackingDeps([])

    expect(await runTaskEndChecks("/ws", config(orders, billing), deps, { changedOnly: true })).toEqual([])
    expect(launched).toEqual([])
  })

  it("remembers a project as passing only when every one of its checks passed", async () => {
    const { deps, launched, accepted } = trackingDeps(["/ws/orders", "/ws/billing"], ["orders style"])

    await runTaskEndChecks("/ws", config(orders, ordersStyle, billing), deps, { changedOnly: true })

    expect(launched).toEqual(["orders arch", "orders style", "billing arch"])
    expect(accepted).toEqual(["/ws/billing"])
  })

  it("runs at task end only the changed projects that hold one of the given files", async () => {
    const { deps, launched, accepted } = trackingDeps(["/ws/orders", "/ws/billing"])

    await runTaskEndChecks("/ws", config(orders, ordersStyle, billing), deps, {
      changedOnly: true,
      files: ["orders/src/main/java/shop/Order.java"],
    })

    expect(launched).toEqual(["orders arch", "orders style"])
    expect(accepted).toEqual(["/ws/orders"])
  })

  it("runs every check without changedOnly, and remembers the projects that passed", async () => {
    const { deps, launched, accepted } = trackingDeps([])

    await runTaskEndChecks("/ws", config(orders, ordersStyle, billing), deps)

    expect(launched).toEqual(["orders arch", "orders style", "billing arch"])
    expect(accepted).toEqual(["/ws/orders", "/ws/billing"])
  })

  it("treats a project without dir as the directory of interlint.yaml", async () => {
    const { deps, launched, accepted } = trackingDeps(["/repo"])

    await runTaskEndChecks("/repo", config(scriptTaskEnd), deps, { changedOnly: true })

    expect(launched).toEqual(["node slow.mjs"])
    expect(accepted).toEqual(["/repo"])
  })

  it("fails at task end a check whose dir does not exist, without running or tracking it, and runs the rest", async () => {
    const { deps, launched, accepted } = trackingDeps(["/ws/billing"])
    const looked: string[] = []
    const lookup = deps.changes.lookup
    deps.changes.lookup = (dir) => (looked.push(dir), lookup(dir))
    deps.hasDirectory = (dir) => dir !== "/ws/orders"

    const outcomes = await runTaskEndChecks("/ws", config(orders, billing), deps, { changedOnly: true })

    expect(outcomes.map((outcome) => [outcome.check.name, outcome.status])).toEqual([
      ["orders/architecture", "missing-dir"],
      ["billing/architecture", "passed"],
    ])
    expect(launched).toEqual(["billing arch"])
    expect(looked).toEqual(["/ws/billing"])
    expect(accepted).toEqual(["/ws/billing"])
  })

  it("runs nothing at edit for a check whose dir does not exist", async () => {
    const { deps, launched, touched } = trackingDeps([])
    deps.hasDirectory = () => false
    deps.hasExecutable = () => true

    expect(await runEditChecks("/ws", config(orders), ["orders/src/A.java"], deps)).toEqual([])
    expect([launched, touched]).toEqual([[], []])
  })

  it("marks at edit the project of every changed file, even one no edit check runs for", async () => {
    const { deps, launched, touched } = trackingDeps([])

    await runEditChecks("/ws", config(orders, billing), ["billing/README.md", "orders/pom.xml", "web/App.java"], deps)

    expect(touched).toEqual(["/ws/orders", "/ws/billing"])
    expect(launched).toEqual([])
  })
})

describe("a report that also lists what the build accepted", () => {
  const quality: Check = { name: "pmd", run: "./mvnw -q compile pmd:check", report: "maven", when: "task-end" }
  const failure = { title: "EmptyCatchBlock", violations: [{ text: "Avoid empty catch blocks" }] }

  function depsExiting(exitCode: number) {
    const { deps } = fakeDeps({ mvnd: false })
    const reader = { snapshot: () => new Map(), read: () => ({ found: true, failures: [failure] }) }
    deps.run = async () => ({ exitCode, output: "" })
    deps.readers = { archunit: reader, maven: { ...reader, alsoListsAccepted: true } }
    return deps
  }

  it("passes when Maven exits 0, whatever the report lists", async () => {
    const [outcome] = await runTaskEndChecks("/repo", config(quality), depsExiting(0))

    expect(outcome).toMatchObject({ status: "passed" })
  })

  it("shows the report's failures when Maven fails", async () => {
    const [outcome] = await runTaskEndChecks("/repo", config(quality), depsExiting(1))

    expect(outcome).toMatchObject({ status: "violations", failures: [failure] })
  })

  it("keeps at edit an ArchUnit failure in a class the edit did not change", async () => {
    const deps = depsExiting(1)
    const elsewhere = { title: "ARCH-01", violations: [{ text: "Customer calls OrderEntity", path: "src/main/java/shop/Customer.java" }] }
    deps.readers = { ...deps.readers, archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [elsewhere] }) } }
    deps.hasExecutable = () => true

    const [outcome] = await runEditChecks("/repo", config(mavenEdit), ["src/main/java/shop/Order.java"], deps)

    expect(outcome).toMatchObject({ status: "violations", failures: [elsewhere] })
  })

  it("leaves the ArchUnit rule as it was: its failures count even when the command exits 0", async () => {
    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), depsExiting(0))

    expect(outcome).toMatchObject({ status: "violations", failures: [failure] })
  })
})

describe("an edit check whose tool can check only some files", () => {
  it("is limited to the changed sources of its project, given relative to its dir", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })
    const scoped: string[][] = []
    deps.editScopes = { maven: (command, files) => (scoped.push(files), `${command} --only`) }
    const quality: Check = { name: "orders/checkstyle", dir: "orders", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" }

    await runEditChecks(
      "/ws",
      config(quality),
      ["orders/app/src/main/java/shop/Order.java", "orders/README.md", "billing/src/main/java/shop/Invoice.java"],
      deps,
    )

    expect(scoped).toEqual([["app/src/main/java/shop/Order.java"]])
    expect(launched).toEqual(["mvnd -q checkstyle:check --only"])
  })

  it("runs as written at task end", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })
    deps.editScopes = { maven: (command) => `${command} --only` }
    const quality: Check = { name: "checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" }

    await runTaskEndChecks("/repo", config(quality), deps)

    expect(launched).toEqual(["./mvnw -q checkstyle:check"])
  })
})

describe("a report from broken compiled classes", () => {
  const failure = { title: "ARCH-01", violations: [{ text: "Field <com.acme.Order.status> has type <OrderStatus>" }] }

  it("reports the broken build instead of its violations, and leaves the project changed", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    const accepted: string[] = []
    deps.changes = { ...deps.changes, accept: (dir) => accepted.push(dir) }
    deps.run = async () => ({ exitCode: 1, output: "" })
    deps.readers = {
      ...deps.readers,
      archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [failure], typesWithoutPackage: ["OrderStatus"] }) },
    }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "broken-build", typesWithoutPackage: ["OrderStatus"] })
    expect(outcome).not.toHaveProperty("failures")
    expect(accepted).toEqual([])
  })
})

describe("the command output", () => {
  it("reaches the report reader, for reports that cannot say why the command failed", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    const seen: string[] = []
    deps.run = async () => ({ exitCode: 1, output: "[ERROR] Failed to execute goal" })
    deps.readers = {
      ...deps.readers,
      archunit: { ...PASSING_READER, read: (_dir: string, _before: ReadonlyMap<string, string>, output: string) => (seen.push(output), { found: true, failures: [] }) },
    }

    await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(seen).toEqual(["[ERROR] Failed to execute goal"])
  })
})
