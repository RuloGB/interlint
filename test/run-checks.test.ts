import { describe, expect, it } from "vitest"
import type { Check, Report } from "../src/domain/check.js"
import { usesMaven, withMavenDaemon } from "../src/domain/maven-command.js"
import type { PendingEdit, PendingEdits, ReportResult } from "../src/application/checking/ports.js"
import { type CheckDeps, runEditChecks, runTaskEndChecks } from "../src/application/checking/run-checks.js"

const PASSING_READER = { snapshot: () => new Map(), read: () => ({ found: true, failures: [] }) }

/** Fake adapters that record the commands they are asked to run. */
function fakeDeps(options: { mvnd: boolean }) {
  const launched: string[] = []
  const deps: CheckDeps = {
    run: async (command) => {
      launched.push(command)
      return { exitCode: 0, output: "" }
    },
    readers: { archunit: PASSING_READER, maven: PASSING_READER, jacoco: PASSING_READER, eslint: PASSING_READER, depcruise: PASSING_READER },
    hasExecutable: (name) => options.mvnd && name === "mvnd",
    lock: (_projectDir, work) => work(),
    changes: {
      lookup: () => ({ changed: true, record: undefined, fingerprint: "", lastModifiedMs: 0 }),
      accept: () => {},
      touch: () => {},
    },
    hasDirectory: () => true,
    editScopes: {},
    removeBrokenClasses: () => [],
    pending: memoryPending(),
    metrics: () => {},
  }
  return { deps, launched }
}

/** Pending edits kept in memory, as the state directory keeps them across processes. */
function memoryPending(): PendingEdits & { saved: Map<string, PendingEdit[]>; files(check: string): string[] } {
  const saved = new Map<string, PendingEdit[]>()
  return {
    saved,
    list: (projectDir, check) => [...(saved.get(`${projectDir}|${check}`) ?? [])],
    save: (projectDir, check, edits) => (saved.set(`${projectDir}|${check}`, [...edits]), true),
    /** The check's pending files in `/repo`, without their lines. */
    files: (check) => (saved.get(`/repo|${check}`) ?? []).map(({ file }) => file),
  }
}

/** Pending edits of `files` that wrote no lines, as an edit without line counts leaves them. */
const noLines = (files: string[]): PendingEdit[] => files.map((file) => ({ file, lines: 0 }))

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
      lookup: (dir) => ({ changed: changed.includes(dir), record: `record of ${dir}`, fingerprint: "", lastModifiedMs: 0 }),
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

describe("the reports a build already left", () => {
  const architecture: Check = { name: "architecture", run: "./mvnw -q test -Dtest=LayersTest", report: "archunit", when: "task-end" }
  const pmd: Check = { name: "pmd", run: "./mvnw -q pmd:check", report: "maven", when: "task-end" }
  const failure = { title: "ARCH-01: rule", violations: [{ text: "Order calls OrderEntity" }] }
  const store = { path: "archunit_store", typesWithoutPackage: ["Order"], hidden: 1 }

  function reusingDeps(fresh: Partial<Record<Report, ReportResult>>) {
    const { deps, launched } = fakeDeps({ mvnd: false })
    const accepted: string[] = []
    const asked: [string, string, number][] = []
    deps.changes = {
      lookup: () => ({ changed: true, record: "record", fingerprint: "", lastModifiedMs: 1000 }),
      accept: (dir) => void accepted.push(dir),
      touch: () => {},
    }
    const readFresh = (report: Report) => (dir: string, command: string, sinceMs: number) => {
      asked.push([dir, command, sinceMs])
      return fresh[report]
    }
    deps.readers = {
      archunit: { ...PASSING_READER, readFresh: readFresh("archunit") },
      maven: { ...PASSING_READER, alsoListsAccepted: true, readFresh: readFresh("maven") },
      jacoco: PASSING_READER,
      eslint: PASSING_READER,
      depcruise: PASSING_READER,
    }
    return { deps, launched, accepted, asked }
  }

  it("passes at task end, without running it, a check whose reports written since the project's last change show it passed", async () => {
    const { deps, launched, accepted, asked } = reusingDeps({ archunit: { found: true, failures: [] } })

    const outcomes = await runTaskEndChecks("/repo", config(architecture, pmd), deps, { changedOnly: true })

    expect(outcomes.map((outcome) => [outcome.check.name, outcome.status])).toEqual([
      ["architecture", "passed"],
      ["pmd", "passed"],
    ])
    expect(launched).toEqual([pmd.run])
    expect(asked).toEqual([
      ["/repo", architecture.run, 1000],
      ["/repo", pmd.run, 1000],
    ])
    expect(accepted).toEqual(["/repo"])
  })

  it("runs the check when those reports show failures, broken classes or a broken store", async () => {
    for (const result of [
      { found: true, failures: [failure] },
      { found: true, failures: [], typesWithoutPackage: ["Order"] },
      { found: true, failures: [], brokenStores: [store] },
    ]) {
      const { deps, launched } = reusingDeps({ archunit: result })

      await runTaskEndChecks("/repo", config(architecture), deps, { changedOnly: true })

      expect(launched).toEqual([architecture.run])
    }
  })

  it("runs every check without changedOnly, whatever the reports show", async () => {
    const { deps, launched, asked } = reusingDeps({ archunit: { found: true, failures: [] }, maven: { found: true, failures: [] } })

    await runTaskEndChecks("/repo", config(architecture, pmd), deps)

    expect(launched).toEqual([architecture.run, pmd.run])
    expect(asked).toEqual([])
  })

  it("never reads them at edit", async () => {
    const { deps, launched, asked } = reusingDeps({ archunit: { found: true, failures: [] } })
    deps.hasExecutable = () => true

    await runEditChecks("/repo", config({ ...architecture, when: "edit" }), ["src/main/java/shop/Order.java"], deps)

    expect(launched).toEqual([withMavenDaemon(architecture.run)])
    expect(asked).toEqual([])
  })
})

describe("a report that also lists what the build accepted", () => {
  const quality: Check = { name: "pmd", run: "./mvnw -q compile pmd:check", report: "maven", when: "task-end" }
  const failure = { title: "EmptyCatchBlock", violations: [{ text: "Avoid empty catch blocks" }] }

  function depsExiting(exitCode: number) {
    const { deps } = fakeDeps({ mvnd: false })
    const reader = { snapshot: () => new Map(), read: () => ({ found: true, failures: [failure] }) }
    deps.run = async () => ({ exitCode, output: "" })
    deps.readers = { archunit: reader, maven: { ...reader, alsoListsAccepted: true }, jacoco: reader, eslint: reader, depcruise: reader }
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
    const scoped: { files: string[]; dir: string }[] = []
    deps.editScopes = { maven: (command, files, dir) => (scoped.push({ files, dir }), `${command} --only`) }
    const quality: Check = { name: "orders/checkstyle", dir: "orders", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" }

    await runEditChecks(
      "/ws",
      config(quality),
      ["orders/app/src/main/java/shop/Order.java", "orders/README.md", "billing/src/main/java/shop/Invoice.java"],
      deps,
    )

    expect(scoped).toEqual([{ files: ["app/src/main/java/shop/Order.java"], dir: "/ws/orders" }])
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

describe("an edit check with every", () => {
  const pmd: Check = { name: "pmd", run: "mvnd -q pmd:check", report: "maven", when: "edit", every: 5 }
  const checkstyle: Check = { name: "checkstyle", run: "mvnd -q checkstyle:check", report: "maven", when: "edit" }
  const source = (name: string) => `src/main/java/shop/${name}.java`
  const [a, b, c, d, e, f, g] = ["A", "B", "C", "D", "E", "F", "G"].map(source) as [string, string, string, string, string, string, string]

  /** Deps whose PMD report holds one violation in each of `failing`, and whose run fails when there is any. */
  function pmdDeps(failing: () => string[]) {
    const { deps, launched } = fakeDeps({ mvnd: true })
    const scoped: string[][] = []
    deps.editScopes = { maven: (command, files) => (scoped.push(files), command) }
    deps.run = async (command) => (launched.push(command), { exitCode: failing().length > 0 ? 1 : 0, output: "" })
    deps.readers = {
      ...deps.readers,
      maven: {
        ...PASSING_READER,
        read: () => ({
          found: true,
          failures: failing().map((path) => ({ title: "PMD", violations: [{ text: `in ${path}`, path }] })),
        }),
      },
    }
    return { deps, launched, scoped, pending: deps.pending as ReturnType<typeof memoryPending> }
  }

  async function editOneByOne(deps: CheckDeps, checks: Check[], files: string[]) {
    const outcomes = []
    for (const file of files) outcomes.push(await runEditChecks("/repo", config(...checks), [file], deps))
    return outcomes
  }

  it("does not run on the first 4 distinct sources and runs on the 5th", async () => {
    const { deps, launched } = pmdDeps(() => [])

    const outcomes = await editOneByOne(deps, [pmd], [a, b, c, d, e])

    expect(outcomes.map((ran) => ran.length)).toEqual([0, 0, 0, 0, 1])
    expect(launched).toEqual([pmd.run])
  })

  it("runs on the 5th edit for all 5 files and shows the failures of each of them", async () => {
    const { deps, scoped } = pmdDeps(() => [a, b, c, d, e, "src/main/java/shop/Other.java"])

    const outcomes = await editOneByOne(deps, [pmd], [a, b, c, d, e])

    expect(scoped).toEqual([[a, b, c, d, e]])
    const fifth = outcomes[4]![0]!
    expect(fifth.status).toBe("violations")
    const paths = fifth.status === "violations" ? fifth.failures.flatMap((failure) => failure.violations.map((v) => v.path)) : []
    expect(paths).toEqual([a, b, c, d, e])
  })

  it("counts a file edited twice once", async () => {
    const { deps, launched } = pmdDeps(() => [])

    await editOneByOne(deps, [pmd], [a, b, a, c, b, d])
    expect(launched).toEqual([])
    await editOneByOne(deps, [pmd], [e])
    expect(launched).toEqual([pmd.run])
  })

  it("does not count files that are not sources of the check", async () => {
    const { deps, launched } = pmdDeps(() => [])

    await editOneByOne(deps, [pmd], [a, b, c, d, "README.md", "pom.xml"])
    expect(launched).toEqual([])
    await editOneByOne(deps, [pmd], [e])
    expect(launched).toEqual([pmd.run])
  })

  it.each([
    ["without every", { ...pmd, every: undefined }],
    ["with every: 1", { ...pmd, every: 1 }],
  ])("runs on every edit %s, on the edited file only, and keeps no pending files", async (_, check) => {
    const { deps, launched, scoped, pending } = pmdDeps(() => [])

    await editOneByOne(deps, [check], [a, b])

    expect(launched).toEqual([pmd.run, pmd.run])
    expect(scoped).toEqual([[a], [b]])
    expect(pending.saved.size).toBe(0)
  })

  it("leaves a check without every running on every edit next to one with it", async () => {
    const { deps, launched } = pmdDeps(() => [])

    await editOneByOne(deps, [checkstyle, pmd], [a, b, c, d, e])

    expect(launched).toEqual([...Array(4).fill(checkstyle.run), checkstyle.run, pmd.run])
  })

  it("starts counting again once the check passed", async () => {
    const { deps, launched, pending } = pmdDeps(() => [])

    await editOneByOne(deps, [pmd], [a, b, c, d, e, f])

    expect(launched).toEqual([pmd.run])
    expect(pending.files("pmd")).toEqual([f])
  })

  it("keeps the files pending while the check fails, so each next edit runs it on them all", async () => {
    let failing = [c]
    const { deps, launched, scoped, pending } = pmdDeps(() => failing)

    await editOneByOne(deps, [pmd], [a, b, c, d, e, f])
    expect(launched).toEqual([pmd.run, pmd.run])
    expect(scoped).toEqual([
      [a, b, c, d, e],
      [a, b, c, d, e, f],
    ])

    failing = []
    await editOneByOne(deps, [pmd], [c])
    expect(scoped.at(-1)).toEqual([a, b, c, d, e, f])
    expect(pending.files("pmd")).toEqual([])
    await editOneByOne(deps, [pmd], [g])
    expect(launched).toHaveLength(3)
  })

  it("keeps the files pending when the command fails without a report", async () => {
    const { deps, pending } = pmdDeps(() => [])
    deps.run = async () => ({ exitCode: 1, output: "BUILD FAILURE" })
    deps.readers = { ...deps.readers, maven: { ...PASSING_READER, read: () => ({ found: false, failures: [] }) } }

    const outcomes = await editOneByOne(deps, [pmd], [a, b, c, d, e])

    expect(outcomes[4]![0]!.status).toBe("failed")
    expect(pending.files("pmd")).toEqual([a, b, c, d, e])
  })

  it("runs at once when the pending files cannot be saved", async () => {
    const { deps, launched } = pmdDeps(() => [])
    deps.pending = { list: () => [], save: () => false }

    await editOneByOne(deps, [pmd], [a])

    expect(launched).toEqual([pmd.run])
  })

  it("runs at once on the edited files when the pending files cannot be read, and leaves them as they were", async () => {
    const { deps, launched, scoped } = pmdDeps(() => [])
    const saved: PendingEdit[][] = []
    deps.pending = { list: () => undefined, save: (_dir, _check, files) => (saved.push(files), true) }

    await editOneByOne(deps, [pmd], [a])

    expect(launched).toEqual([pmd.run])
    expect(scoped).toEqual([[a]])
    expect(saved).toEqual([])
  })

  it("does not count pending files that are no longer sources of the check", async () => {
    const { deps, launched, pending } = pmdDeps(() => [])
    pending.save("/repo", "pmd", noLines(["README.md", "other/pom.xml", b, c, d]))

    await editOneByOne(deps, [{ ...pmd, dir: undefined }], [e])

    expect(launched).toEqual([])
    expect(pending.files("pmd")).toEqual([b, c, d, e])
  })

  it("does not count pending sources outside the check's dir, as after its dir changed", async () => {
    const { deps, launched, pending } = pmdDeps(() => [])
    const orders: Check = { ...pmd, dir: "orders" }
    pending.save("/repo", "pmd", noLines([`billing/${a}`, `orders/${b}`, `orders/${c}`, `orders/${d}`]))

    await editOneByOne(deps, [orders], [`orders/${e}`])

    expect(launched).toEqual([])
    expect(pending.files("pmd")).toEqual([`orders/${b}`, `orders/${c}`, `orders/${d}`, `orders/${e}`])
  })

  it("keeps a count per project of a workspace", async () => {
    const { deps, launched } = pmdDeps(() => [])
    const orders: Check = { ...pmd, name: "orders/pmd", dir: "orders", every: 2 }
    const billing: Check = { ...pmd, name: "billing/pmd", dir: "billing", every: 2 }

    await editOneByOne(deps, [orders, billing], [`orders/${a}`, `billing/${a}`])
    expect(launched).toEqual([])
    await editOneByOne(deps, [orders, billing], [`orders/${b}`])
    expect(launched).toEqual([pmd.run])
  })

  it("reads and saves the pending files only under the project lock, so two edits in a row lose or repeat none", async () => {
    const { deps, launched } = pmdDeps(() => [])
    const memory = memoryPending()
    let locked = false
    let queue = Promise.resolve()
    deps.lock = <T>(_dir: string, work: () => Promise<T>) => {
      const turn = queue.then(async () => {
        locked = true
        try {
          return await work()
        } finally {
          locked = false
        }
      })
      queue = turn.then(
        () => {},
        () => {},
      )
      return turn
    }
    const guard = <T>(action: () => T) => {
      if (!locked) throw new Error("pending files used outside the project lock")
      return action()
    }
    deps.pending = {
      list: (dir, check) => guard(() => memory.list(dir, check)),
      save: (dir, check, files) => guard(() => memory.save(dir, check, files)),
    }
    const two: Check = { ...pmd, every: 2 }

    await Promise.all([a, b, c, d].map((file) => runEditChecks("/repo", config(two), [file], deps)))

    expect(launched).toEqual([pmd.run, pmd.run])
    expect(memory.files("pmd")).toEqual([])
  })
})

describe("task end with pending edits", () => {
  const pmd: Check = { name: "pmd", run: "mvnd -q pmd:check", report: "maven", when: "edit", every: 5 }
  const file = "src/main/java/shop/A.java"

  it("runs the check of a project with pending edits before reaching every, and empties them when it passes", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })
    await runEditChecks("/repo", config(pmd), [file], deps)
    expect(launched).toEqual([])

    const outcomes = await runTaskEndChecks("/repo", config(pmd), deps, { changedOnly: true })

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
    expect(launched).toEqual([pmd.run])
    expect(deps.pending.list("/repo", "pmd")).toEqual([])
  })

  it("keeps the pending edits when the check fails at task end", async () => {
    const { deps } = fakeDeps({ mvnd: true })
    await runEditChecks("/repo", config(pmd), [file], deps)
    deps.run = async () => ({ exitCode: 1, output: "BUILD FAILURE" })
    deps.readers = { ...deps.readers, maven: { ...PASSING_READER, read: () => ({ found: false, failures: [] }) } }

    await runTaskEndChecks("/repo", config(pmd), deps, { changedOnly: true })

    expect(deps.pending.list("/repo", "pmd")).toEqual([{ file, lines: 0 }])
  })
})

describe("an edit check with lines", () => {
  const pmd: Check = { name: "pmd", run: "mvnd -q pmd:check", report: "maven", when: "edit", every: 5, lines: 100 }
  const source = (name: string) => `src/main/java/shop/${name}.java`
  const [a, b, c, d, e] = ["A", "B", "C", "D", "E"].map(source) as [string, string, string, string, string]

  function scopedDeps() {
    const { deps, launched } = fakeDeps({ mvnd: true })
    const scoped: string[][] = []
    deps.editScopes = { maven: (command, files) => (scoped.push(files), command) }
    return { deps, launched, scoped }
  }

  /** One edit of `file` that wrote `lines` lines in it. */
  const edit = (deps: CheckDeps, check: Check, file: string, lines: number) =>
    runEditChecks("/repo", config(check), [file], deps, new Map([[file, lines]]))

  it("does not run after small edits of a few files, and leaves them to task end", async () => {
    const { deps, launched } = scopedDeps()

    for (const file of [a, b, c]) await edit(deps, pmd, file, 2)
    expect(launched).toEqual([])

    await runTaskEndChecks("/repo", config(pmd), deps, { changedOnly: true })
    expect(launched).toEqual([pmd.run])
  })

  it("runs on the edit that brings the lines written to lines, on all the pending files", async () => {
    const { deps, launched, scoped } = scopedDeps()

    expect(await edit(deps, pmd, a, 60)).toEqual([])
    const outcomes = await edit(deps, pmd, b, 40)

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["passed"])
    expect(launched).toEqual([pmd.run])
    expect(scoped).toEqual([[a, b]])
  })

  it("runs on every edited files before reaching lines, whichever comes first", async () => {
    const { deps, launched } = scopedDeps()

    for (const file of [a, b, c, d]) await edit(deps, pmd, file, 1)
    expect(launched).toEqual([])
    await edit(deps, pmd, e, 1)
    expect(launched).toEqual([pmd.run])
  })

  it("adds up the lines of a file edited twice", async () => {
    const { deps, launched } = scopedDeps()

    await edit(deps, pmd, a, 60)
    await edit(deps, pmd, a, 40)

    expect(launched).toEqual([pmd.run])
  })

  it("waits only for lines when it has no every, however many files are edited", async () => {
    const { deps, launched } = scopedDeps()
    const onlyLines: Check = { ...pmd, every: undefined }

    for (const file of [a, b, c, d, e, source("F")]) await edit(deps, onlyLines, file, 1)
    expect(launched).toEqual([])
    await edit(deps, onlyLines, a, 94)
    expect(launched).toEqual([pmd.run])
  })

  it("counts no lines for an edit that gives none", async () => {
    const { deps, launched } = scopedDeps()

    for (const file of [a, b, c, d]) await runEditChecks("/repo", config(pmd), [file], deps)
    expect(launched).toEqual([])
    expect(deps.pending.list("/repo", "pmd")).toEqual([a, b, c, d].map((file) => ({ file, lines: 0 })))
  })

  it("does not count the lines of files that are not sources of the check", async () => {
    const { deps, launched } = scopedDeps()

    await runEditChecks("/repo", config(pmd), [a, "README.md"], deps, new Map([[a, 1], ["README.md", 500]]))

    expect(launched).toEqual([])
    expect(deps.pending.list("/repo", "pmd")).toEqual([{ file: a, lines: 1 }])
  })

  it("counts the lines from zero again once the check passed", async () => {
    const { deps, launched } = scopedDeps()

    await edit(deps, pmd, a, 100)
    await edit(deps, pmd, b, 99)

    expect(launched).toEqual([pmd.run])
    expect(deps.pending.list("/repo", "pmd")).toEqual([{ file: b, lines: 99 }])
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

describe("classes an IDE compiled with errors", () => {
  const scriptCheck: Check = { name: "script", run: "node check.mjs", report: "archunit", when: "task-end" }

  it("are removed from the check's project before a Maven check runs", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    const events: string[] = []
    deps.removeBrokenClasses = (dir) => (events.push(`remove ${dir}`), [])
    deps.run = async (command, cwd) => (events.push(`run ${command} in ${cwd}`), { exitCode: 0, output: "" })
    const inModule: Check = { ...mavenEdit, dir: "orders" }

    await runTaskEndChecks("/repo", config(inModule), deps)

    expect(events).toEqual(["remove /repo/orders", "run ./mvnw -q test -Dtest=ArchitectureRulesTest in /repo/orders"])
  })

  it("are left alone for a check that does not run Maven", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    const removed: string[] = []
    deps.removeBrokenClasses = (dir) => (removed.push(dir), [])

    await runTaskEndChecks("/repo", config(scriptCheck), deps)

    expect(removed).toEqual([])
  })

  it("written while a Maven check ran make Interlint remove them and run it once more", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })
    const leftovers = [[], ["/repo/target/classes/shop/Order.class"], []]
    deps.removeBrokenClasses = () => leftovers.shift() ?? []
    const exits = [1, 0]
    deps.run = async (command) => (launched.push(command), { exitCode: exits.shift() ?? 0, output: "" })

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(launched).toHaveLength(2)
    expect(outcome).toMatchObject({ status: "passed" })
  })

  it("make a passing report from the second run the one shown, with the edit's command", async () => {
    const { deps, launched } = fakeDeps({ mvnd: true })
    let removals = 0
    deps.removeBrokenClasses = () => (++removals === 2 ? ["/repo/target/classes/shop/Order.class"] : [])
    const failure = { title: "ARCH-01", violations: [{ text: "Field <com.acme.Order.status> has type <OrderStatus>" }] }
    const reads = [
      { found: true, failures: [failure], typesWithoutPackage: ["OrderStatus"] },
      { found: true, failures: [] },
    ]
    const exits = [1, 0]
    deps.run = async (command) => (launched.push(command), { exitCode: exits.shift() ?? 0, output: "" })
    deps.readers = { ...deps.readers, archunit: { snapshot: () => new Map(), read: () => reads.shift() ?? { found: true, failures: [] } } }

    const [outcome] = await runEditChecks("/repo", config(mavenEdit), ["src/main/java/shop/Order.java"], deps)

    expect(launched).toEqual(["mvnd -q test -Dtest=ArchitectureRulesTest", "mvnd -q test -Dtest=ArchitectureRulesTest"])
    expect(outcome).toMatchObject({ status: "passed" })
  })

  it("do not make a failed check run again when there are none", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })
    deps.run = async (command) => (launched.push(command), { exitCode: 1, output: "[ERROR] COMPILATION ERROR" })

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(launched).toHaveLength(1)
    expect(outcome).toMatchObject({ status: "failed", exitCode: 1 })
  })

  it("make a check run again only once, and show the second run's failure", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })
    let removals = 0
    deps.removeBrokenClasses = () => (++removals === 1 ? [] : ["/repo/target/classes/shop/Order.class"])
    const outputs = ["first", "[ERROR] cannot access CustomerData"]
    deps.run = async (command) => (launched.push(command), { exitCode: 1, output: outputs.shift() ?? "" })

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(launched).toHaveLength(2)
    expect(outcome).toMatchObject({ status: "failed", outputTail: "[ERROR] cannot access CustomerData" })
  })

  it("found after a passing check do not make it run again", async () => {
    const { deps, launched } = fakeDeps({ mvnd: false })
    let removals = 0
    deps.removeBrokenClasses = () => (++removals === 2 ? ["/repo/target/classes/shop/Order.class"] : [])

    await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(launched).toHaveLength(1)
  })
})

describe("a FreezingArchRule store written from broken classes", () => {
  const store = { path: "archunit_store", typesWithoutPackage: ["Order"], hidden: 1 }

  it("passes a check whose failures were all frozen in it, and names the store from the root", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    deps.run = async () => ({ exitCode: 1, output: "" })
    deps.readers = { ...deps.readers, archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [], brokenStores: [store] }) } }

    const [outcome] = await runTaskEndChecks("/repo", config({ ...mavenEdit, dir: "orders" }), deps)

    expect(outcome).toMatchObject({ status: "passed", brokenStores: [{ ...store, path: "orders/archunit_store" }] })
  })

  it("still shows the failures it did not hold", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    const failure = { title: "ARCH-02", violations: [{ text: "Method <com.acme.web.Ctl.list()> calls method <com.acme.infra.Repo.all()> in (Ctl.java:21)" }] }
    deps.run = async () => ({ exitCode: 1, output: "" })
    deps.readers = { ...deps.readers, archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [failure], brokenStores: [store] }) } }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "violations", failures: [failure], brokenStores: [store] })
  })

  it("does not pass a run that also failed for another reason, such as a module that does not compile", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    deps.run = async () => ({ exitCode: 1, output: "[ERROR] Failed to execute goal ...maven-compiler-plugin..." })
    deps.readers = {
      ...deps.readers,
      archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [], brokenStores: [store], otherFailure: true }) },
    }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "failed", exitCode: 1, brokenStores: [store] })
  })

  it("does not pass a failed run that it held nothing back from", async () => {
    const { deps } = fakeDeps({ mvnd: false })
    deps.run = async () => ({ exitCode: 1, output: "[ERROR] Tests run: 1, Errors: 1" })
    deps.readers = { ...deps.readers, archunit: { snapshot: () => new Map(), read: () => ({ found: true, failures: [], brokenStores: [{ ...store, hidden: 0 }] }) } }

    const [outcome] = await runTaskEndChecks("/repo", config(mavenEdit), deps)

    expect(outcome).toMatchObject({ status: "failed", exitCode: 1 })
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
