import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/adapters/yaml-config/config.js"
import { main } from "../src/cli.js"

let projectDir: string
let binDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "interlint-init-"))
  binDir = mkdtempSync(join(tmpdir(), "interlint-bin-"))
  vi.stubEnv("PATH", binDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

function writeFile(path: string, content: string) {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true })
  writeFileSync(join(projectDir, path), content)
}

function archTest(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".java".length)
  writeFile(
    path,
    `package com.acme;\n\nimport com.tngtech.archunit.junit.ArchTest;\n\nclass ${name} {\n  @ArchTest\n  static final ArchRule RULE = noClasses().should().accessClassesThat().haveSimpleName("X");\n}\n`,
  )
}

function installMavenDaemon() {
  const file = join(binDir, process.platform === "win32" ? "mvnd.cmd" : "mvnd")
  writeFileSync(file, "")
  chmodSync(file, 0o755)
}

async function run(...args: string[]) {
  let stdout = ""
  let stderr = ""
  const exitCode = await main(args, {
    cwd: projectDir,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { exitCode, stdout, stderr }
}

const PLUGIN_SOURCE = join(import.meta.dirname, "..", "integrations", "opencode", "interlint", "index.ts")
const PLUGIN_COPY = join(".opencode", "plugins", "interlint", "index.ts")

const readConfig = () => readFileSync(join(projectDir, "interlint.yaml"), "utf8")

describe("interlint init", () => {
  it("writes an architecture check that runs only the classes with @ArchTest", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/architecture/LayersTest.java")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("src/test/java/com/acme/OrderServiceTest.java", "class OrderServiceTest { @Test void works() {} }\n")
    writeFile("src/main/java/com/acme/Order.java", "// Mentions @ArchTest but is not a test.\nclass Order {}\n")

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir)).toEqual({
      checks: [
        {
          name: "architecture",
          run: "./mvnw -q test -Dtest=ArchitectureRulesTest,LayersTest",
          report: "archunit",
          when: "edit",
        },
      ],
    })
  })

  it("ignores @ArchTest when it only appears in a comment or a string", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile(
      "src/test/java/com/acme/OrderServiceTest.java",
      [
        "class OrderServiceTest {",
        "  // @ArchTest static final ArchRule OLD = ...;",
        "  /* @ArchTest",
        "     static final ArchRule DISABLED = ...; */",
        '  String note = "see @ArchTest"; // http://example.com',
        "}",
        "",
      ].join("\n"),
    )

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("finds @ArchTest after a char literal holding a double quote", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("src/test/java/com/acme/QuoteRulesTest.java", `class QuoteRulesTest { char q = '"'; @ArchTest Object r = "x"; }\n`)

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest,QuoteRulesTest")
  })

  it("skips a directory whose name ends in .java", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    mkdirSync(join(projectDir, "src", "test", "java", "legacy.java"), { recursive: true })

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("leaves out a class whose file name is not a plain Java name, so it never reaches the shell", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    archTest("src/test/java/com/acme/Evil$(id).java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("accepts class names with non-ASCII letters", async () => {
    archTest("src/test/java/com/acme/ReglasDeArquitecturaÑTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ReglasDeArquitecturaÑTest")
  })

  it("names a class once when two packages have one with the same name", async () => {
    archTest("src/test/java/com/acme/orders/ArchitectureRulesTest.java")
    archTest("src/test/java/com/acme/billing/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("keeps a long run command on one line", async () => {
    for (const name of ["AdaptersRulesTest", "ApplicationRulesTest", "DomainRulesTest", "NamingRulesTest"]) {
      archTest(`src/test/java/com/acme/${name}.java`)
    }

    await run("init")

    expect(readConfig()).toContain(
      "    run: mvn -q test -Dtest=AdaptersRulesTest,ApplicationRulesTest,DomainRulesTest,NamingRulesTest\n",
    )
  })

  it("says so when the --cwd directory does not exist", async () => {
    const { exitCode, stderr } = await run("init", "--cwd", "missing")

    expect(exitCode).toBe(2)
    expect(stderr).toBe(`interlint: ${join(projectDir, "missing")} does not exist\n`)
  })

  it("writes the same check with and without mvnd on the PATH", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    const withoutDaemon = readConfig()

    installMavenDaemon()
    expect((await run("init", "--force")).exitCode).toBe(0)

    expect(readConfig()).toBe(withoutDaemon)
    expect(loadConfig(projectDir).checks[0]).toMatchObject({ run: "./mvnw -q test -Dtest=ArchitectureRulesTest", when: "edit" })
  })

  it("uses the Windows wrapper when only mvnw.cmd is there", async () => {
    writeFile("mvnw.cmd", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("./mvnw -q test -Dtest=ArchitectureRulesTest")
  })

  it("uses mvn when the project has no Maven Wrapper", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe("mvn -q test -Dtest=ArchitectureRulesTest")
  })

  it("says what it detected and what it wrote", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    installMavenDaemon()

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: ArchitectureRulesTest",
        "  Maven: ./mvnw (Maven Wrapper)",
        "  mvnd: on the PATH, so the architecture check runs after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("says that without mvnd the check waits for task end", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    const { stdout } = await run("init")

    expect(stdout).toContain("  Maven: mvn (no Maven Wrapper)\n")
    expect(stdout).toContain(
      "  mvnd: not on the PATH, so the architecture check runs at task end; install mvnd to run it after each edit\n",
    )
  })

  it("does not overwrite a different interlint.yaml without --force", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "interlint: interlint.yaml already exists and is different from what init would write; rerun with --force to replace it\n",
    )
    expect(readConfig()).toBe("# The team's own config\n")
  })

  it("replaces a different interlint.yaml with --force", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile("interlint.yaml", "# The team's own config\n")

    const { exitCode, stdout } = await run("init", "--force")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n")
    expect(loadConfig(projectDir).checks).toHaveLength(1)
  })

  it("leaves the same result when it runs twice", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    const first = readConfig()

    const { exitCode, stdout, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(readConfig()).toBe(first)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n")
    expect(stdout).not.toContain("Wrote:")
  })

  it("treats a checked-out copy with Windows line endings as the same file", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    await run("init")
    writeFile("interlint.yaml", readConfig().replaceAll("\n", "\r\n"))

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n")
  })

  it("says there are no ArchUnit tests and writes nothing", async () => {
    writeFile("mvnw", "")
    writeFile("src/test/java/com/acme/OrderServiceTest.java", "class OrderServiceTest {}\n")

    const { exitCode, stdout, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "interlint: no ArchUnit tests found: no file under src/test/java contains @ArchTest, so there is nothing to check. Nothing was written.\n",
    )
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("works on another directory with --cwd", async () => {
    archTest("api/src/test/java/com/acme/ArchitectureRulesTest.java")

    expect((await run("init", "--cwd", "api")).exitCode).toBe(0)
    expect(existsSync(join(projectDir, "api", "interlint.yaml"))).toBe(true)
  })

  it("exits 2 for an unknown agent", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")

    const { exitCode, stderr } = await run("init", "--agent", "cursor")

    expect(exitCode).toBe(2)
    expect(stderr).toContain('--agent must be opencode (got "cursor")')
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })
})

describe("interlint init --agent opencode", () => {
  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("copies the OpenCode plugin to .opencode/plugins/interlint/", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "opencode")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .opencode/plugins/interlint/index.ts\n")
  })

  it("leaves opencode.json and opencode.jsonc as they are", async () => {
    const config = '{\n  // The team\'s settings\n  "plugins": ["./elsewhere"]\n}\n'
    writeFile("opencode.jsonc", config)

    await run("init", "--agent", "opencode")

    expect(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).toBe(config)
    expect(existsSync(join(projectDir, "opencode.json"))).toBe(false)
  })

  it("leaves the same result when it runs twice", async () => {
    await run("init", "--agent", "opencode")

    const { exitCode, stdout } = await run("init", "--agent", "opencode")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .opencode/plugins/interlint/index.ts\n")
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
  })

  it("replaces an outdated copy of the plugin without --force", async () => {
    writeFile(PLUGIN_COPY, "// An older Interlint plugin\n")

    const { exitCode, stdout } = await run("init", "--agent", "opencode")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("  .opencode/plugins/interlint/index.ts\n")
    expect(readFileSync(join(projectDir, PLUGIN_COPY), "utf8")).toBe(readFileSync(PLUGIN_SOURCE, "utf8"))
  })

  it("does not copy the plugin when interlint.yaml cannot be written", async () => {
    writeFile("interlint.yaml", "# The team's own config\n")

    expect((await run("init", "--agent", "opencode")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false)
  })

  it("does not copy the plugin when there are no ArchUnit tests", async () => {
    rmSync(join(projectDir, "src"), { recursive: true })

    expect((await run("init", "--agent", "opencode")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".opencode"))).toBe(false)
  })

  it("installs no plugin without --agent", async () => {
    await run("init")

    expect(existsSync(join(projectDir, ".opencode"))).toBe(false)
  })
})
