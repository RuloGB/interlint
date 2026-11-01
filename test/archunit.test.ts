import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseSurefireXml, readArchUnitReport, snapshotReports } from "../src/adapters/driven/maven/reports/archunit-reader.js"

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "surefire", name), "utf8")

function suite(...testcases: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.ArchitectureTest" tests="${testcases.length}">
${testcases.join("\n")}
</testsuite>`
}

function archUnitFailure(testName: string, rule: string, violations: string[]) {
  const message = [
    `Architecture Violation [Priority: MEDIUM] - Rule '${rule}' was violated (${violations.length} times):`,
    ...violations,
  ]
    .join("&#10;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  return `<testcase name="${testName}" classname="ArchitectureTest">
  <failure message="${message}" type="java.lang.AssertionError"><![CDATA[stack trace]]></failure>
</testcase>`
}

describe("parseSurefireXml", () => {
  it("returns one failure per violated rule, titled by the because() text with its ID", () => {
    const failures = parseSurefireXml(fixture("two-rules-violated.xml"))

    expect(failures.map((failure) => failure.title)).toEqual([
      "ARCH-01: application has ZERO dependencies on infrastructure",
      "ARCH-01: domain depends on nothing outside domain (and domain exceptions)",
    ])
  })

  it("keeps each violation with its class and line", () => {
    const [first] = parseSurefireXml(fixture("two-rules-violated.xml"))

    expect(first?.violations).toEqual([
      {
        text: "Method <com.myorg.api.application.domain.Project.toEntity()> calls constructor <com.myorg.api.infrastructure.outbound.dbs.main.entity.ProjectEntity.<init>()> in (Project.java:70)",
        className: "com.myorg.api.application.domain.Project",
        file: "Project.java",
        line: 70,
      },
      {
        text: "Method <com.myorg.api.application.domain.Project.toEntity()> calls method <com.myorg.api.infrastructure.outbound.dbs.main.entity.ProjectEntity.setId(java.lang.String)> in (Project.java:71)",
        className: "com.myorg.api.application.domain.Project",
        file: "Project.java",
        line: 71,
      },
      {
        text: "Method <com.myorg.api.application.domain.Project.toEntity()> has return type <com.myorg.api.infrastructure.outbound.dbs.main.entity.ProjectEntity> in (Project.java:0)",
        className: "com.myorg.api.application.domain.Project",
        file: "Project.java",
      },
    ])
  })

  it("accepts an ID written in brackets", () => {
    const xml = suite(
      archUnitFailure(
        "DOMAIN_RULE",
        "no classes should depend on infrastructure, because [ARQ-003] El dominio no depende de infraestructura",
        ["Class <com.acme.domain.Order> depends on <com.acme.infra.OrderEntity> in (Order.java:12)"],
      ),
    )

    expect(parseSurefireXml(xml)[0]?.title).toBe("[ARQ-003] El dominio no depende de infraestructura")
  })

  it("identifies a because() without ID by the rule field name", () => {
    const xml = suite(
      archUnitFailure(
        "NO_NATIVE_QUERIES",
        "no methods should be annotated with @Query, because Spring Data JPA only: no native queries",
        ["Method <com.acme.infra.OrderRepository.find()> is annotated with @Query in (OrderRepository.java:9)"],
      ),
    )

    expect(parseSurefireXml(xml)[0]?.title).toBe(
      "NO_NATIVE_QUERIES: Spring Data JPA only: no native queries",
    )
  })

  it("identifies a rule without because() by its field name and rule text", () => {
    const xml = suite(
      archUnitFailure("NO_CYCLES", "slices matching 'com.acme.(*)..' should be free of cycles", [
        "Cycle detected: Slice a -> Slice b -> Slice a",
      ]),
    )

    const [failure] = parseSurefireXml(xml)

    expect(failure?.title).toBe("NO_CYCLES: slices matching 'com.acme.(*)..' should be free of cycles")
    expect(failure?.violations).toEqual([{ text: "Cycle detected: Slice a -> Slice b -> Slice a" }])
  })

  it("reports a failure that is not from ArchUnit with its first message line", () => {
    const xml = suite(`<testcase name="loadsClasses" classname="ArchitectureTest">
  <error message="Could not import classes&#10;second line" type="java.lang.IllegalStateException"/>
</testcase>`)

    expect(parseSurefireXml(xml)).toEqual([
      { title: "loadsClasses: Could not import classes", violations: [] },
    ])
  })

  it("returns nothing when every test passes", () => {
    expect(parseSurefireXml(suite('<testcase name="DOMAIN_IS_PURE" classname="ArchitectureTest"/>'))).toEqual([])
  })
})

describe("readArchUnitReport", () => {
  let projectDir: string
  let reportsDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-archunit-"))
    reportsDir = join(projectDir, "target", "surefire-reports")
    mkdirSync(reportsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it("reads only the reports written since the snapshot", () => {
    writeFileSync(join(reportsDir, "TEST-com.acme.OldTest.xml"), fixture("two-rules-violated.xml"))
    const before = snapshotReports(projectDir)
    writeFileSync(
      join(reportsDir, "TEST-com.acme.ArchitectureTest.xml"),
      suite('<testcase name="DOMAIN_IS_PURE" classname="ArchitectureTest"/>'),
    )

    expect(readArchUnitReport(projectDir, before)).toEqual({ found: true, failures: [] })
  })

  it("reads a report that the run rewrote", () => {
    const report = join(reportsDir, "TEST-ArchitectureRulesTest.xml")
    writeFileSync(report, suite('<testcase name="DOMAIN_IS_PURE" classname="ArchitectureTest"/>'))
    const oneMinuteAgo = new Date(Date.now() - 60_000)
    utimesSync(report, oneMinuteAgo, oneMinuteAgo)
    const before = snapshotReports(projectDir)
    writeFileSync(report, fixture("two-rules-violated.xml"))

    expect(readArchUnitReport(projectDir, before).failures).toHaveLength(2)
  })

  it("reads a report rewritten within the same timestamp tick", () => {
    const report = join(reportsDir, "TEST-ArchitectureRulesTest.xml")
    const tick = new Date(Date.now() - 60_000)
    writeFileSync(report, suite('<testcase name="DOMAIN_IS_PURE" classname="ArchitectureTest"/>'))
    utimesSync(report, tick, tick)
    const before = snapshotReports(projectDir)
    writeFileSync(report, fixture("two-rules-violated.xml"))
    utimesSync(report, tick, tick)

    expect(readArchUnitReport(projectDir, before).failures).toHaveLength(2)
  })

  it("says so when the run wrote no report", () => {
    expect(readArchUnitReport(projectDir, snapshotReports(projectDir))).toEqual({ found: false, failures: [] })
  })

  it("reads the reports of every module, at any depth, and finds each source in the module that has it", () => {
    rmSync(reportsDir, { recursive: true })
    for (const module of ["launcher", "domain", "adapters/rest/api"]) {
      mkdirSync(join(projectDir, module), { recursive: true })
      writeFileSync(join(projectDir, module, "pom.xml"), "<project/>")
    }
    const sourceDir = join(projectDir, "domain", "src", "main", "java", "com", "myorg", "api", "application", "domain")
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, "Project.java"), "class Project {}")
    const before = snapshotReports(projectDir)
    const deepReports = join(projectDir, "adapters", "rest", "api", "target", "surefire-reports")
    mkdirSync(deepReports, { recursive: true })
    writeFileSync(join(deepReports, "TEST-ArchitectureRulesTest.xml"), fixture("two-rules-violated.xml"))

    const { found, failures } = readArchUnitReport(projectDir, before)

    expect(found).toBe(true)
    expect(failures[0]?.violations[0]?.path).toBe("domain/src/main/java/com/myorg/api/application/domain/Project.java")
  })

  it("resolves the source file of each violation when it exists", () => {
    const sourceDir = join(projectDir, "src", "main", "java", "com", "myorg", "api", "application", "domain")
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, "Project.java"), "class Project {}")
    const before = snapshotReports(projectDir)
    writeFileSync(join(reportsDir, "TEST-ArchitectureRulesTest.xml"), fixture("two-rules-violated.xml"))

    const { failures } = readArchUnitReport(projectDir, before)

    expect(failures[0]?.violations.map((violation) => violation.path)).toEqual([
      "src/main/java/com/myorg/api/application/domain/Project.java",
      "src/main/java/com/myorg/api/application/domain/Project.java",
      "src/main/java/com/myorg/api/application/domain/Project.java",
    ])
  })

  it("lists the types a violation names without a package: classes javac could not have compiled", () => {
    const before = snapshotReports(projectDir)
    writeFileSync(
      join(reportsDir, "TEST-ArchitectureRulesTest.xml"),
      suite(
        archUnitFailure("DOMAIN_IS_PURE", "classes should only depend on domain, because ARCH-01: domain is pure", [
          "Constructor <com.myorg.api.application.domain.Project.<init>(java.lang.String, ProjectName, ProjectStatus)> has parameter of type <ProjectName> in (Project.java:0)",
          "Field <com.myorg.api.application.domain.Project.status> has type <ProjectStatus> in (Project.java:0)",
          "Method <com.myorg.api.application.domain.Project.name()> has return type <ProjectName> in (Project.java:0)",
        ]),
      ),
    )

    expect(readArchUnitReport(projectDir, before).typesWithoutPackage).toEqual(["ProjectName", "ProjectStatus"])
  })

  it("lists no type for primitives, arrays, constructors and full names", () => {
    const before = snapshotReports(projectDir)
    writeFileSync(
      join(reportsDir, "TEST-ArchitectureRulesTest.xml"),
      suite(
        archUnitFailure("NO_STANDARD_STREAMS", "no classes should access System.out, because LOG-04: no System.out", [
          "Method <com.acme.domain.Order.debug(int, byte[], java.lang.String[])> gets field <java.lang.System.out> in (Order.java:68)",
          "Constructor <com.acme.domain.Order.<init>(long)> calls constructor <com.acme.infra.OrderEntity.<init>()> in (Order.java:12)",
          "Field <com.acme.domain.Order.total> has type <double> in (Order.java:0)",
          "Method <com.acme.domain.Order.lines()> has generic return type <java.util.List<T>> in (Order.java:0)",
        ]),
      ),
    )

    expect(readArchUnitReport(projectDir, before)).not.toHaveProperty("typesWithoutPackage")
  })
})

describe("a FreezingArchRule store written from broken classes", () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "interlint-store-"))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  const FROZEN_BROKEN = "Field <com.acme.mapper.OrderMapper.order> has type <Order> in (OrderMapper.java:0)"
  const FROZEN_AGAIN = "Field <com.acme.mapper.OrderMapper.order> has type <com.acme.domain.Order> in (OrderMapper.java:14)"
  const NEW_VIOLATION = "Method <com.acme.web.OrderController.list()> calls method <com.acme.infra.OrderRepository.all()> in (OrderController.java:21)"

  function store(module: string, path: string, ...violations: string[]) {
    const dir = resolve(projectDir, module, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "stored.rules"), "classes\\ should\\ only\\ depend\\ on\\ domain=5d1b8a2e-rule\n")
    writeFileSync(join(dir, "5d1b8a2e-rule"), violations.join("\n"))
  }

  function report(module: string, ...violations: string[]) {
    const dir = join(projectDir, module, "target", "surefire-reports")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "TEST-ArchitectureRulesTest.xml"),
      suite(archUnitFailure("MAPPERS", "classes should only depend on domain, because ARCH-07: mappers", violations)),
    )
  }

  it("leaves out the violations frozen there, and names the store and its types", () => {
    store("", "archunit_store", FROZEN_BROKEN)
    const before = snapshotReports(projectDir)
    report("", FROZEN_AGAIN, NEW_VIOLATION)

    const { failures, brokenStores } = readArchUnitReport(projectDir, before)

    expect(failures.map((failure) => failure.violations.map((violation) => violation.text))).toEqual([[NEW_VIOLATION]])
    expect(brokenStores).toEqual([{ path: "archunit_store", typesWithoutPackage: ["Order"], hidden: 1 }])
  })

  it("drops a rule whose violations were all frozen there", () => {
    store("", "archunit_store", FROZEN_BROKEN)
    const before = snapshotReports(projectDir)
    report("", FROZEN_AGAIN)

    expect(readArchUnitReport(projectDir, before)).toEqual({
      found: true,
      failures: [],
      brokenStores: [{ path: "archunit_store", typesWithoutPackage: ["Order"], hidden: 1 }],
    })
  })

  it("is found where archunit.properties puts it, in a module", () => {
    writeFileSync(join(projectDir, "pom.xml"), "<project/>")
    mkdirSync(join(projectDir, "orders", "src", "test", "resources"), { recursive: true })
    writeFileSync(join(projectDir, "orders", "pom.xml"), "<project/>")
    writeFileSync(
      join(projectDir, "orders", "src", "test", "resources", "archunit.properties"),
      "# frozen rules\nfreeze.store.default.path = config/frozen\n",
    )
    store("orders", "config/frozen", FROZEN_BROKEN)
    const before = snapshotReports(projectDir)
    report("orders", FROZEN_AGAIN)

    expect(readArchUnitReport(projectDir, before).brokenStores).toEqual([
      { path: "orders/config/frozen", typesWithoutPackage: ["Order"], hidden: 1 },
    ])
  })

  it("is found at an absolute path from archunit.properties", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "interlint-store-elsewhere-"))
    try {
      mkdirSync(join(projectDir, "src", "test", "resources"), { recursive: true })
      writeFileSync(
        join(projectDir, "src", "test", "resources", "archunit.properties"),
        `freeze.store.default.path=${join(elsewhere, "frozen").split("\\").join("/")}\n`,
      )
      store("", join(elsewhere, "frozen"), FROZEN_BROKEN)
      const before = snapshotReports(projectDir)
      report("", FROZEN_AGAIN)

      expect(readArchUnitReport(projectDir, before).brokenStores).toMatchObject([{ typesWithoutPackage: ["Order"], hidden: 1 }])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("is not reported when its violations name every type in full", () => {
    store("", "archunit_store", FROZEN_AGAIN)
    const before = snapshotReports(projectDir)
    report("", NEW_VIOLATION)

    const result = readArchUnitReport(projectDir, before)

    expect(result).not.toHaveProperty("brokenStores")
    expect(result.failures[0]?.violations).toHaveLength(1)
  })

  it("is reported, with nothing left out, when the run reported none of its violations", () => {
    store("", "archunit_store", FROZEN_BROKEN)
    const before = snapshotReports(projectDir)
    report("", NEW_VIOLATION)

    const { failures, brokenStores } = readArchUnitReport(projectDir, before)

    expect(failures[0]?.violations).toHaveLength(1)
    expect(brokenStores).toEqual([{ path: "archunit_store", typesWithoutPackage: ["Order"], hidden: 0 }])
  })
})
