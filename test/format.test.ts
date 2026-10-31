import { describe, expect, it } from "vitest"
import type { Check } from "../src/domain/check.js"
import { formatOutcomes } from "../src/application/checking/format-outcomes.js"

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
        "  javac never compiles a class like that. Another compiler, usually an IDE building automatically,",
        "  wrote to target/ while the check ran. Do not change the code for these violations.",
        "  Turn off the IDE's automatic build for this project, or run the build with clean, and check again.",
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

    expect(failed(1)).toContain("✗ checkstyle · the command failed (exit code 1) and left no Checkstyle or PMD failures\n")
    expect(failed(0)).toContain("✗ checkstyle · the command exited 0 but wrote no Checkstyle or PMD report\n")
  })
})
