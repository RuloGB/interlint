import { describe, expect, it } from "vitest"
import type { Check } from "../src/domain/check.js"
import { formatNotices, formatOutcomes, formatPassed } from "../src/application/checking/format-outcomes.js"

const architecture: Check = {
  name: "architecture",
  run: "./mvnw -q test -Dtest=ArchitectureRulesTest",
  report: "archunit",
  when: "task-end",
}

describe("formatOutcomes", () => {
  it("prints nothing when every check passes", () => {
    expect(formatOutcomes([{ check: architecture, status: "passed", durationMs: 10 }])).toBe("")
  })

  it("prints each violated rule with its violations and where they are", () => {
    const output = formatOutcomes([
      {
        check: architecture,
        status: "violations",
        durationMs: 10,
        failures: [
          {
            title: "ARCH-01: domain depends on nothing outside domain",
            violations: [
              {
                text: "Method <com.acme.domain.Order.toEntity()> calls constructor <com.acme.infra.OrderEntity.<init>()> in (Order.java:27)",
                file: "Order.java",
                line: 27,
                path: "src/main/java/com/acme/domain/Order.java",
              },
              { text: "Cycle detected: Slice a -> Slice b -> Slice a" },
            ],
          },
        ],
      },
    ])

    expect(output).toBe(
      [
        "✗ architecture · ARCH-01: domain depends on nothing outside domain",
        "",
        "  Method <com.acme.domain.Order.toEntity()> calls constructor <com.acme.infra.OrderEntity.<init>()> in (Order.java:27)",
        "    at src/main/java/com/acme/domain/Order.java:27",
        "  Cycle detected: Slice a -> Slice b -> Slice a",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("caps the violations shown for one rule", () => {
    const violations = Array.from({ length: 12 }, (_, index) => ({ text: `violation ${index + 1}` }))

    const output = formatOutcomes([
      { check: architecture, status: "violations", durationMs: 10, failures: [{ title: "ARCH-02: rule", violations }] },
    ])

    expect(output).toContain("  violation 10\n  … and 2 more\n")
    expect(output).not.toContain("violation 11")
  })

  it("says so when a command exits 0 without writing a report", () => {
    const output = formatOutcomes([
      {
        check: architecture,
        status: "failed",
        durationMs: 10,
        command: architecture.run,
        exitCode: 0,
        outputTail: "[INFO] Tests are skipped.",
      },
    ])

    expect(output).toContain("✗ architecture · the command exited 0 but wrote no ArchUnit report\n")
  })

  it("says the compiled classes are broken, with the types that show it, instead of the violations", () => {
    const output = formatOutcomes([
      {
        check: architecture,
        status: "broken-build",
        durationMs: 10,
        typesWithoutPackage: ["ProjectName", "ProjectStatus", "ProjectPort", "Clock"],
      },
    ])

    expect(output).toBe(
      [
        "✗ architecture · the compiled classes are broken, so its ArchUnit violations are not shown",
        "",
        "  The report names types without a package: <ProjectName>, <ProjectStatus>, <ProjectPort> and 1 more.",
        "  javac never compiles a class like that. An IDE building automatically wrote to target/ while the check",
        "  ran. Do not change the code for these violations: check again.",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("says a check's dir does not exist and how to fix it", () => {
    const check = { name: "gone/checkstyle", dir: "gone", run: "./mvnw -q checkstyle:check", report: "maven" as const, when: "task-end" as const }

    expect(formatOutcomes([{ check, durationMs: 0, status: "missing-dir" }])).toBe(
      '✗ gone/checkstyle · its dir "gone" does not exist\n\n  Fix dir in interlint.yaml, or remove the check if the project is gone.\n\nFix these problems before continuing.\n',
    )
  })

  it("prints a failed command with the tail of its output", () => {
    const output = formatOutcomes([
      {
        check: architecture,
        status: "failed",
        durationMs: 10,
        command: architecture.run,
        exitCode: 1,
        outputTail: "[ERROR] COMPILATION ERROR\n[ERROR] Order.java:[3,8] cannot find symbol",
      },
    ])

    expect(output).toBe(
      [
        "✗ architecture · the command failed (exit code 1) and left no ArchUnit failures",
        "",
        "  Command: ./mvnw -q test -Dtest=ArchitectureRulesTest",
        "  Last lines of its output:",
        "    [ERROR] COMPILATION ERROR",
        "    [ERROR] Order.java:[3,8] cannot find symbol",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })
})

describe("formatOutcomes for Checkstyle and PMD", () => {
  const checkstyle: Check = { name: "checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "task-end" }

  it("prints each rule with its text and file:line, like an ArchUnit rule", () => {
    const output = formatOutcomes([
      {
        check: checkstyle,
        status: "violations",
        durationMs: 10,
        failures: [
          {
            title: "LineLength",
            violations: [
              {
                text: "Line is longer than 80 characters (found 87).",
                file: "Order.java",
                line: 8,
                path: "src/main/java/shop/Order.java",
              },
            ],
          },
        ],
      },
    ])

    expect(output).toBe(
      [
        "✗ checkstyle · LineLength",
        "",
        "  Line is longer than 80 characters (found 87).",
        "    at src/main/java/shop/Order.java:8",
        "",
        "Fix these problems before continuing.",
        "",
      ].join("\n"),
    )
  })

  it("names Checkstyle and PMD when Maven fails without leaving failures in their reports", () => {
    const failed = (exitCode: number) =>
      formatOutcomes([
        { check: checkstyle, status: "failed", durationMs: 10, command: checkstyle.run, exitCode, outputTail: "" },
      ])

    expect(failed(1)).toContain("✗ checkstyle · the command failed (exit code 1) and left no Checkstyle, PMD or SpotBugs failures\n")
    expect(failed(0)).toContain("✗ checkstyle · the command exited 0 but wrote no Checkstyle, PMD or SpotBugs report\n")
  })
})

describe("formatNotices", () => {
  const store = { path: "archunit_store", typesWithoutPackage: ["Order", "Customer"], hidden: 2 }

  it("prints nothing when no store is broken", () => {
    expect(formatNotices([{ check: architecture, status: "passed", durationMs: 10 }])).toBe("")
  })

  it("tells the user how to refreeze a store written from broken classes, with the check's Maven", () => {
    const output = formatNotices([{ check: architecture, status: "passed", durationMs: 10, brokenStores: [store] }])

    expect(output).toBe(
      [
        "ℹ Interlint · for the user: the ArchUnit store archunit_store was frozen from broken compiled classes",
        "",
        "  It names types without a package: <Order>, <Customer>. Its frozen violations no longer match",
        "  the code, so ArchUnit reports them as new. Interlint did not show the agent 2 of them.",
        "  Refreeze it from a clean build: ./mvnw clean test -Darchunit.freeze.refreeze=true",
        "  Agent: do not change the code for this. Tell the user.",
        "",
      ].join("\n"),
    )
  })

  it("says so when the run reported none of the store's violations", () => {
    const output = formatNotices([
      { check: architecture, status: "passed", durationMs: 10, brokenStores: [{ ...store, hidden: 0 }] },
    ])

    expect(output).toContain("  the code, so ArchUnit reports them as new. None of them came up in this run.\n")
  })

  it("names the check's directory, and each store once", () => {
    const inModule: Check = { ...architecture, run: "mvn -q test", dir: "orders" }
    const moduleStore = { ...store, path: "orders/archunit_store" }
    const output = formatNotices([
      { check: inModule, status: "passed", durationMs: 10, brokenStores: [moduleStore] },
      { check: { ...inModule, name: "again" }, status: "passed", durationMs: 10, brokenStores: [moduleStore] },
    ])

    expect(output.match(/orders\/archunit_store/g)).toHaveLength(1)
    expect(output).toContain("  Refreeze it from a clean build, in orders: mvn clean test -Darchunit.freeze.refreeze=true\n")
  })
})

describe("formatPassed", () => {
  const checkstyle: Check = { name: "checkstyle", run: "mvnd -q checkstyle:check", report: "maven", when: "edit" }

  it("names each check that passed, with how long it took", () => {
    expect(
      formatPassed([
        { check: checkstyle, status: "passed", durationMs: 1_234 },
        { check: architecture, status: "passed", durationMs: 4_250 },
      ]),
    ).toBe("✓ Interlint · checks passed: checkstyle (1.2s), architecture (4.3s)\n")
  })

  it("says when a check passed in the last build instead of running", () => {
    expect(formatPassed([{ check: architecture, status: "passed", durationMs: 0, fromBuild: true }])).toBe(
      "✓ Interlint · checks passed: architecture (in the last build)\n",
    )
  })

  it("prints nothing when no check ran", () => {
    expect(formatPassed([])).toBe("")
  })

  it("prints nothing when a check did not pass", () => {
    expect(
      formatPassed([
        { check: checkstyle, status: "passed", durationMs: 1_000 },
        { check: architecture, status: "missing-dir", durationMs: 0 },
      ]),
    ).toBe("")
  })
})
