import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/adapters/driven/yaml-config/config.js"
import { ConfigError } from "../src/application/checking/ports.js"

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-config-"))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function writeConfig(content: string) {
  writeFileSync(join(projectDir, "interlint.yaml"), content)
}

function configErrorOf(action: () => unknown): ConfigError {
  try {
    action()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error("expected a ConfigError")
}

describe("loadConfig", () => {
  it("reads the checks with their four fields", () => {
    writeConfig(`
checks:
  - name: architecture
    run: ./mvnw -q test -Dtest=ArchitectureRulesTest
    report: archunit
    when: edit
`)

    expect(loadConfig(projectDir)).toEqual({
      checks: [
        {
          name: "architecture",
          run: "./mvnw -q test -Dtest=ArchitectureRulesTest",
          report: "archunit",
          when: "edit",
        },
      ],
    })
  })

  it("reads a Checkstyle or PMD check with report: maven", () => {
    writeConfig(`
checks:
  - name: checkstyle
    run: ./mvnw -q checkstyle:check
    report: maven
    when: task-end
`)

    expect(loadConfig(projectDir).checks[0]?.report).toBe("maven")
  })

  it("reads the directory a check runs in, relative to interlint.yaml, whether it exists or not", () => {
    writeConfig(`
checks:
  - name: orders/architecture
    dir: orders
    run: ./mvnw -q test
    report: archunit
    when: edit
  - name: billing/checkstyle
    dir: ./apps\\billing/
    run: ./mvnw -q checkstyle:check
    report: maven
    when: task-end
  - name: root
    dir: .
    run: ./mvnw -q test
    report: archunit
    when: task-end
`)

    expect(loadConfig(projectDir).checks.map((check) => check.dir)).toEqual(["orders", "apps/billing", undefined])
  })

  it.each(["../orders", "orders/../../x", "/orders", "C:/orders", ""])("rejects the directory %j", (dir) => {
    writeConfig(`
checks:
  - name: architecture
    dir: "${dir}"
    run: ./mvnw test
    report: archunit
    when: edit
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      `interlint.yaml: checks[0].dir must be a directory inside the project, relative to interlint.yaml (got "${dir}")`,
    )
  })

  it("fails when interlint.yaml does not exist", () => {
    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      `interlint.yaml not found in ${projectDir}`,
    )
  })

  it("fails when the YAML cannot be parsed", () => {
    writeConfig("checks: [unclosed")

    expect(configErrorOf(() => loadConfig(projectDir)).message).toMatch(
      /^interlint\.yaml is not valid YAML: /,
    )
  })

  it("keeps metrics: false, and leaves metrics out when the key is absent", () => {
    const check = `
checks:
  - name: architecture
    run: ./mvnw test
    report: archunit
    when: edit
`
    writeConfig(`metrics: false${check}`)
    expect(loadConfig(projectDir).metrics).toBe(false)

    writeConfig(check)
    expect("metrics" in loadConfig(projectDir)).toBe(false)
  })

  it("fails when metrics is not true or false", () => {
    writeConfig(`
metrics: no-thanks
checks:
  - name: architecture
    run: ./mvnw test
    report: archunit
    when: edit
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      'interlint.yaml: metrics must be true or false (got "no-thanks")',
    )
  })

  it("fails when checks is missing or empty", () => {
    writeConfig("checks: []")

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      "interlint.yaml: checks must be a non-empty list",
    )
  })

  it("names the missing field", () => {
    writeConfig(`
checks:
  - name: architecture
    report: archunit
    when: task-end
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      "interlint.yaml: checks[0].run must be a non-empty string",
    )
  })

  it("names the field with an unsupported value", () => {
    writeConfig(`
checks:
  - name: architecture
    run: ./mvnw test
    report: archunit
    when: task-end
  - name: quality
    run: ./gradlew checkstyleMain
    report: gradle
    when: task-end
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      'interlint.yaml: checks[1].report must be one of: archunit, maven, jacoco, eslint, depcruise (got "gradle")',
    )
  })

  it("rejects an unknown when", () => {
    writeConfig(`
checks:
  - name: architecture
    run: ./mvnw test
    report: archunit
    when: commit
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      'interlint.yaml: checks[0].when must be one of: edit, task-end (got "commit")',
    )
  })

  it("reads how many edited files a check waits for", () => {
    writeConfig(`
checks:
  - name: pmd
    run: mvnd -q pmd:check
    report: maven
    when: edit
    every: 5
`)

    expect(loadConfig(projectDir).checks[0]).toEqual({
      name: "pmd",
      run: "mvnd -q pmd:check",
      report: "maven",
      when: "edit",
      every: 5,
    })
  })

  it.each(["0", "-1", "2.5", '"5"', "five", "[]"])("rejects every: %s and says what it expects", (value) => {
    writeConfig(`
checks:
  - name: pmd
    run: mvnd -q pmd:check
    report: maven
    when: edit
    every: ${value}
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toMatch(
      /^interlint\.yaml: checks\[0\]\.every must be a whole number of 1 or more \(got .+\)$/,
    )
  })

  it("reads how many written lines a check waits for, with every or without it", () => {
    writeConfig(`
checks:
  - name: pmd
    run: mvnd -q pmd:check
    report: maven
    when: edit
    every: 5
    lines: 100
  - name: architecture
    run: mvnd -q test
    report: archunit
    when: edit
    lines: 200
`)

    expect(loadConfig(projectDir).checks).toEqual([
      { name: "pmd", run: "mvnd -q pmd:check", report: "maven", when: "edit", every: 5, lines: 100 },
      { name: "architecture", run: "mvnd -q test", report: "archunit", when: "edit", lines: 200 },
    ])
  })

  it.each(["0", "-1", "2.5", '"100"', "many", "[]"])("rejects lines: %s and says what it expects", (value) => {
    writeConfig(`
checks:
  - name: pmd
    run: mvnd -q pmd:check
    report: maven
    when: edit
    lines: ${value}
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toMatch(
      /^interlint\.yaml: checks\[0\]\.lines must be a whole number of 1 or more \(got .+\)$/,
    )
  })

  it("rejects two checks with the same name", () => {
    writeConfig(`
checks:
  - name: architecture
    run: ./mvnw test
    report: archunit
    when: edit
  - name: architecture
    run: ./mvnw verify
    report: archunit
    when: task-end
`)

    expect(configErrorOf(() => loadConfig(projectDir)).message).toBe(
      'interlint.yaml: checks[1].name "architecture" is already used by checks[0]',
    )
  })
})
