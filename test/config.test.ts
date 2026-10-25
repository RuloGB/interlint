import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "../src/adapters/yaml-config/config.js"

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
      'interlint.yaml: checks[1].report must be one of: archunit, maven (got "gradle")',
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
