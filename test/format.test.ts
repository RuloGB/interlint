import { describe, expect, it } from "vitest"
import type { Check } from "../src/config/config.js"
import { formatOutcomes } from "../src/output/format.js"

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

  it("prints a failed command with the tail of its output", () => {
    const output = formatOutcomes([
      {
        check: architecture,
        status: "failed",
        durationMs: 10,
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
