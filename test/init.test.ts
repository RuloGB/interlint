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

  it("says there is nothing to check and writes nothing", async () => {
    writeFile("mvnw", "")
    writeFile("src/test/java/com/acme/OrderServiceTest.java", "class OrderServiceTest {}\n")

    const { exitCode, stdout, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has neither maven-checkstyle-plugin nor maven-pmd-plugin. Nothing was written.\n",
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
    expect(stderr).toContain('--agent must be opencode or claude-code (got "cursor")')
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

describe("interlint init --agent claude-code", () => {
  const SETTINGS = join(".claude", "settings.json")
  const POST_EDIT = { type: "command", command: "interlint hook claude-code post-edit", timeout: 120 }
  const STOP = { type: "command", command: "interlint hook claude-code stop", timeout: 600 }
  const SUBAGENT_STOP = { type: "command", command: "interlint hook claude-code subagent-stop", timeout: 600 }
  const readSettings = () => readFileSync(join(projectDir, SETTINGS), "utf8")

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("adds the post-edit, stop and subagent-stop hooks to .claude/settings.json", async () => {
    const { exitCode, stdout, stderr } = await run("init", "--agent", "claude-code")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(readSettings())).toEqual({
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write", hooks: [POST_EDIT] }],
        Stop: [{ hooks: [STOP] }],
        SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      },
    })
    expect(stdout).toContain("Wrote:\n  interlint.yaml\n  .claude/settings.json\n")
  })

  it("keeps the settings and hooks that are already there", async () => {
    const lint = { matcher: "Write", hooks: [{ type: "command", command: "npm run lint" }] }
    const notify = { hooks: [{ type: "command", command: "notify-send done" }] }
    writeFile(
      SETTINGS,
      JSON.stringify({
        permissions: { allow: ["Bash(./mvnw:*)"] },
        env: { MAVEN_OPTS: "-Xmx1g" },
        hooks: { PostToolUse: [lint], Stop: [notify], SessionStart: [notify] },
      }),
    )

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(0)

    expect(JSON.parse(readSettings())).toEqual({
      permissions: { allow: ["Bash(./mvnw:*)"] },
      env: { MAVEN_OPTS: "-Xmx1g" },
      hooks: {
        PostToolUse: [lint, { matcher: "Edit|Write", hooks: [POST_EDIT] }],
        Stop: [notify, { hooks: [STOP] }],
        SessionStart: [notify],
        SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
      },
    })
  })

  it("leaves the same result when it runs twice", async () => {
    writeFile(SETTINGS, '{ "permissions": { "allow": [] } }\n')
    await run("init", "--agent", "claude-code")
    const first = readSettings()

    const { exitCode, stdout } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Unchanged:\n  interlint.yaml\n  .claude/settings.json\n")
    expect(readSettings()).toBe(first)
  })

  it("leaves a file that already has the hooks exactly as it is, formatting included", async () => {
    const settings = `{\n    "hooks": {\n        "Stop": [{ "hooks": [${JSON.stringify(STOP)}] }],\n        "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [${JSON.stringify(POST_EDIT)}] }],\n        "SubagentStop": [{ "hooks": [${JSON.stringify(SUBAGENT_STOP)}] }]\n    }\n}\n`
    writeFile(SETTINGS, settings)

    expect((await run("init", "--agent", "claude-code")).stdout).toContain("Unchanged:\n  .claude/settings.json\n")
    expect(readSettings()).toBe(settings)
  })

  it("replaces an older Interlint hook instead of adding a second one", async () => {
    const other = { type: "command", command: "npm run lint" }
    writeFile(
      SETTINGS,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [other, { type: "command", command: POST_EDIT.command }] },
            { matcher: "Write", hooks: [{ type: "command", command: POST_EDIT.command, timeout: 60 }] },
          ],
          Stop: [{ hooks: [{ ...STOP, timeout: 60 }] }],
        },
      }),
    )

    await run("init", "--agent", "claude-code")

    expect(JSON.parse(readSettings()).hooks).toEqual({
      PostToolUse: [
        { matcher: "Edit", hooks: [other] },
        { matcher: "Edit|Write", hooks: [POST_EDIT] },
      ],
      Stop: [{ hooks: [STOP] }],
      SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
    })
  })

  it("writes nothing when .claude/settings.json is not valid JSON", async () => {
    writeFile(SETTINGS, '{ "hooks": { // comments are not JSON\n } }\n')

    const { exitCode, stderr } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(2)
    expect(stderr).toContain(".claude/settings.json is not valid JSON")
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
    expect(readSettings()).toBe('{ "hooks": { // comments are not JSON\n } }\n')
  })

  it("writes nothing when the hooks in .claude/settings.json are not what Claude Code expects", async () => {
    writeFile(SETTINGS, '{ "hooks": { "Stop": {} } }')

    const { exitCode, stderr } = await run("init", "--agent", "claude-code")

    expect(exitCode).toBe(2)
    expect(stderr).toContain(".claude/settings.json: hooks.Stop is not a list")
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("does not write the settings when interlint.yaml cannot be written", async () => {
    writeFile("interlint.yaml", "# The team's own config\n")

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".claude"))).toBe(false)
  })

  it("does not write the settings when there are no ArchUnit tests", async () => {
    rmSync(join(projectDir, "src"), { recursive: true })

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(2)
    expect(existsSync(join(projectDir, ".claude"))).toBe(false)
  })
})

describe("interlint init --agent claude-code with an older hook next to the current one", () => {
  const SETTINGS = join(".claude", "settings.json")
  const POST_EDIT = { type: "command", command: "interlint hook claude-code post-edit", timeout: 120 }
  const STOP = { type: "command", command: "interlint hook claude-code stop", timeout: 600 }
  const SUBAGENT_STOP = { type: "command", command: "interlint hook claude-code subagent-stop", timeout: 600 }

  beforeEach(() => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
  })

  it("removes the older copy, so each hook runs once", async () => {
    const other = { type: "command", command: "npm run lint" }
    writeFile(
      SETTINGS,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Edit", hooks: [other, { ...POST_EDIT, timeout: 60 }] },
            { matcher: "Edit|Write", hooks: [POST_EDIT, POST_EDIT] },
          ],
          Stop: [{ hooks: [STOP] }, { hooks: [{ ...STOP, timeout: 30 }] }],
        },
      }),
    )

    expect((await run("init", "--agent", "claude-code")).exitCode).toBe(0)

    expect(JSON.parse(readFileSync(join(projectDir, SETTINGS), "utf8")).hooks).toEqual({
      PostToolUse: [
        { matcher: "Edit", hooks: [other] },
        { matcher: "Edit|Write", hooks: [POST_EDIT] },
      ],
      Stop: [{ hooks: [STOP] }],
      SubagentStop: [{ hooks: [SUBAGENT_STOP] }],
    })
  })
})

describe("interlint init with Checkstyle and PMD", () => {
  const plugin = (artifactId: string) =>
    `      <plugin>\n        <groupId>org.apache.maven.plugins</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`

  function pom({ build = "", rest = "" }: { build?: string; rest?: string }) {
    writeFile(
      "pom.xml",
      `<project>\n  <artifactId>shop</artifactId>\n  <build>\n    <plugins>\n${build}    </plugins>\n  </build>\n${rest}</project>\n`,
    )
  }

  it("adds a checkstyle and a pmd check for edit when pom.xml declares both plugins", async () => {
    writeFile("mvnw", "")
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") })

    const { exitCode, stderr } = await run("init")

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(loadConfig(projectDir).checks).toEqual([
      {
        name: "architecture",
        run: "./mvnw -q test -Dtest=ArchitectureRulesTest -Dcheckstyle.skip -Dpmd.skip",
        report: "archunit",
        when: "edit",
      },
      { name: "checkstyle", run: "./mvnw -q checkstyle:check", report: "maven", when: "edit" },
      { name: "pmd", run: "./mvnw -q compile pmd:check -Dcheckstyle.skip", report: "maven", when: "edit" },
    ])
  })

  it("skips in each check the plugins the other checks run, so one failure shows in one check", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-pmd-plugin") })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual([
      "mvn -q test -Dtest=ArchitectureRulesTest -Dpmd.skip",
      "mvn -q compile pmd:check -Dcheckstyle.skip",
    ])
  })

  it("adds only the check of the plugin it finds, in build or pluginManagement", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    writeFile(
      "pom.xml",
      `<project>\n  <build>\n    <pluginManagement>\n      <plugins>\n${plugin("maven-pmd-plugin")}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
    )

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture", "pmd"])
  })

  it("ignores a plugin that is only in a comment, a profile or the reporting section", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({
      build: `      <!--\n${plugin("maven-checkstyle-plugin")}      -->\n`,
      rest: `  <profiles>\n    <profile>\n      <build>\n        <plugins>\n${plugin("maven-checkstyle-plugin")}        </plugins>\n      </build>\n    </profile>\n  </profiles>\n  <reporting>\n    <plugins>\n${plugin("maven-pmd-plugin")}    </plugins>\n  </reporting>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
  })

  it("still finds a plugin that pins its own dependencies, before or after its artifactId", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    const puppycrawl =
      "        <dependencies>\n          <dependency>\n            <groupId>com.puppycrawl.tools</groupId>\n            <artifactId>checkstyle</artifactId>\n          </dependency>\n        </dependencies>\n"
    pom({
      build:
        `      <plugin>\n        <artifactId>maven-checkstyle-plugin</artifactId>\n${puppycrawl}      </plugin>\n` +
        `      <plugin>\n${puppycrawl}        <artifactId>maven-pmd-plugin</artifactId>\n      </plugin>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture", "checkstyle", "pmd"])
  })

  describe("when the build runs check in an <execution>", () => {
    const execution = (inner: string) =>
      `          <execution>\n${inner}            <goals>\n              <goal>check</goal>\n            </goals>\n            <configuration>\n              <violationSeverity>warning</violationSeverity>\n            </configuration>\n          </execution>\n`
    const withExecutions = (artifactId: string, executions: string) =>
      `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n        <executions>\n${executions}        </executions>\n      </plugin>\n`
    const runs = () => loadConfig(projectDir).checks.map((check) => check.run)

    it("runs that execution, so its configuration applies, and calls one without id `default`", async () => {
      pom({
        build:
          withExecutions("maven-checkstyle-plugin", execution("            <id>style</id>\n            <phase>validate</phase>\n")) +
          withExecutions("maven-pmd-plugin", execution("            <phase>verify</phase>\n")),
      })

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check@style", "mvn -q compile pmd:check@default -Dcheckstyle.skip"])
    })

    it("finds the execution in pluginManagement too", async () => {
      writeFile(
        "pom.xml",
        `<project>\n  <build>\n    <pluginManagement>\n      <plugins>\n${withExecutions("maven-checkstyle-plugin", execution("            <id>style</id>\n"))}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
      )

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check@style"])
    })

    it("runs the plain goal when no execution runs check, one is turned off, or an id could mean something to the shell", async () => {
      const cpdOnly =
        "          <execution>\n            <id>cpd</id>\n            <goals>\n              <goal>cpd-check</goal>\n            </goals>\n          </execution>\n"
      pom({
        build:
          withExecutions(
            "maven-checkstyle-plugin",
            execution("            <id>inherited</id>\n            <phase>none</phase>\n") + execution("            <id>a;rm</id>\n"),
          ) + withExecutions("maven-pmd-plugin", cpdOnly),
      })

      await run("init")

      expect(runs()).toEqual(["mvn -q checkstyle:check", "mvn -q compile pmd:check -Dcheckstyle.skip"])
    })
  })

  it("ignores a plugin that is only a dependency", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    const dependency = (artifactId: string) =>
      `      <dependency>\n        <groupId>org.apache.maven.plugins</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </dependency>\n`
    pom({
      rest: `  <dependencyManagement>\n    <dependencies>\n${dependency("maven-checkstyle-plugin")}    </dependencies>\n  </dependencyManagement>\n  <dependencies>\n${dependency("maven-pmd-plugin")}  </dependencies>\n`,
    })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["architecture"])
  })

  it("says what it detected", async () => {
    archTest("src/test/java/com/acme/ArchitectureRulesTest.java")
    pom({ build: plugin("maven-checkstyle-plugin") + plugin("maven-pmd-plugin") })
    installMavenDaemon()

    const { stdout } = await run("init")

    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: ArchitectureRulesTest",
        "  Checkstyle: maven-checkstyle-plugin in pom.xml",
        "  PMD: maven-pmd-plugin in pom.xml",
        "  Maven: mvn (no Maven Wrapper)",
        "  mvnd: on the PATH, so the architecture, Checkstyle and PMD checks run after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("writes the Checkstyle check alone when there are no ArchUnit tests", async () => {
    pom({ build: plugin("maven-checkstyle-plugin") })

    const { exitCode, stdout } = await run("init")

    expect(exitCode).toBe(0)
    expect(loadConfig(projectDir).checks).toEqual([
      { name: "checkstyle", run: "mvn -q checkstyle:check", report: "maven", when: "edit" },
    ])
    expect(stdout).toBe(
      [
        "Detected:",
        "  ArchUnit tests: none",
        "  Checkstyle: maven-checkstyle-plugin in pom.xml",
        "  Maven: mvn (no Maven Wrapper)",
        "  mvnd: not on the PATH, so the Checkstyle check runs at task end; install mvnd to run it after each edit",
        "",
        "Wrote:",
        "  interlint.yaml",
        "",
      ].join("\n"),
    )
  })

  it("still writes nothing when there are neither ArchUnit tests nor plugins", async () => {
    pom({})

    const { exitCode, stderr } = await run("init")

    expect(exitCode).toBe(2)
    expect(stderr).toBe(
      "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has neither maven-checkstyle-plugin nor maven-pmd-plugin. Nothing was written.\n",
    )
  })
})

describe("interlint init in a multi-module project", () => {
  const managed = (artifactId: string, executionId: string) =>
    `        <plugin>\n          <artifactId>${artifactId}</artifactId>\n          <executions>\n            <execution>\n              <id>${executionId}</id>\n              <goals>\n                <goal>check</goal>\n              </goals>\n            </execution>\n          </executions>\n        </plugin>\n`
  const activated = (artifactId: string) => `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n`

  /** A parent POM that manages plugins for its modules, and a POM per module that turns some of them on. */
  function reactor(dir: string, options: { managed: string[]; modules: Record<string, string[]>; wrapper?: boolean }) {
    const at = (path: string) => (dir === "" ? path : `${dir}/${path}`)
    const modules = Object.keys(options.modules)
    writeFile(
      at("pom.xml"),
      `<project>\n  <packaging>pom</packaging>\n  <modules>\n${modules.map((module) => `    <module>${module}</module>\n`).join("")}  </modules>\n  <build>\n    <pluginManagement>\n      <plugins>\n${options.managed.join("")}      </plugins>\n    </pluginManagement>\n  </build>\n</project>\n`,
    )
    for (const [module, plugins] of Object.entries(options.modules)) {
      writeFile(at(`${module}/pom.xml`), `<project>\n  <build>\n    <plugins>\n${plugins.map(activated).join("")}    </plugins>\n  </build>\n</project>\n`)
    }
    if (options.wrapper !== false) writeFile(at("mvnw"), "")
  }

  const BOTH = ["maven-checkstyle-plugin", "maven-pmd-plugin"]
  const MANAGED_BOTH = [managed("maven-checkstyle-plugin", "style"), managed("maven-pmd-plugin", "pmd")]

  it("finds the @ArchTest classes of a module and runs only that module and the ones it depends on", async () => {
    reactor("", { managed: MANAGED_BOTH, modules: { domain: BOTH, "adapters/rest": BOTH, launcher: BOTH } })
    archTest("launcher/src/test/java/com/acme/ArchitectureRulesTest.java")

    expect((await run("init")).exitCode).toBe(0)

    expect(loadConfig(projectDir).checks).toEqual([
      {
        name: "architecture",
        run: "./mvnw -q test -pl launcher -am -Dtest=ArchitectureRulesTest -Dsurefire.failIfNoSpecifiedTests=false -Dcheckstyle.skip -Dpmd.skip",
        report: "archunit",
        when: "edit",
      },
      { name: "checkstyle", run: "./mvnw -q checkstyle:check@style", report: "maven", when: "edit" },
      { name: "pmd", run: "./mvnw -q compile pmd:check@pmd -Dcheckstyle.skip", report: "maven", when: "edit" },
    ])
  })

  it("names every module that has @ArchTest classes", async () => {
    reactor("", { managed: [], modules: { domain: [], "adapters/rest": [], launcher: [] } })
    archTest("launcher/src/test/java/com/acme/LauncherRulesTest.java")
    archTest("adapters/rest/src/test/java/com/acme/RestRulesTest.java")

    await run("init")

    expect(loadConfig(projectDir).checks[0]?.run).toBe(
      "./mvnw -q test -pl adapters/rest,launcher -am -Dtest=LauncherRulesTest,RestRulesTest -Dsurefire.failIfNoSpecifiedTests=false",
    )
  })

  it("leaves out a plugin that only pluginManagement declares and no module turns on", async () => {
    reactor("", { managed: MANAGED_BOTH, modules: { domain: ["maven-checkstyle-plugin"], launcher: [] } })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.name)).toEqual(["checkstyle"])
  })

  it("counts a plugin a module turns on without the parent managing it", async () => {
    reactor("", { managed: [], modules: { domain: ["maven-pmd-plugin"] } })

    await run("init")

    expect(loadConfig(projectDir).checks.map((check) => check.run)).toEqual(["./mvnw -q compile pmd:check -Dcheckstyle.skip"])
  })

  describe("from the root of a workspace without pom.xml", () => {
    beforeEach(() => {
      reactor("orders", { managed: MANAGED_BOTH, modules: { domain: BOTH, launcher: BOTH } })
      archTest("orders/launcher/src/test/java/com/acme/OrdersRulesTest.java")
      reactor("apps/billing", { managed: MANAGED_BOTH, modules: { core: ["maven-checkstyle-plugin"] }, wrapper: false })
      writeFile("web/package.json", "{}")
      writeFile("web/src/App.java", "class App {}")
      writeFile("docs/README.md", "# Docs")
    })

    it("writes the checks of every Maven project, run in its directory and named after it", async () => {
      expect((await run("init")).exitCode).toBe(0)

      expect(loadConfig(projectDir).checks).toEqual([
        { name: "apps/billing/checkstyle", dir: "apps/billing", run: "mvn -q checkstyle:check@style", report: "maven", when: "edit" },
        {
          name: "orders/architecture",
          dir: "orders",
          run: "./mvnw -q test -pl launcher -am -Dtest=OrdersRulesTest -Dsurefire.failIfNoSpecifiedTests=false -Dcheckstyle.skip -Dpmd.skip",
          report: "archunit",
          when: "edit",
        },
        { name: "orders/checkstyle", dir: "orders", run: "./mvnw -q checkstyle:check@style", report: "maven", when: "edit" },
        { name: "orders/pmd", dir: "orders", run: "./mvnw -q compile pmd:check@pmd -Dcheckstyle.skip", report: "maven", when: "edit" },
      ])
      expect(readConfig()).toContain("  - name: orders/architecture\n    dir: orders\n    run: ")
    })

    it("lists each project with what it detected", async () => {
      writeFile("legacy/pom.xml", "<project/>")
      installMavenDaemon()

      const { stdout } = await run("init")

      expect(stdout).toBe(
        [
          "Detected 3 Maven projects:",
          "  apps/billing",
          "    ArchUnit tests: none",
          "    Checkstyle: maven-checkstyle-plugin in pom.xml",
          "    Maven: mvn (no Maven Wrapper)",
          "  legacy",
          "    nothing to check",
          "  orders",
          "    ArchUnit tests: OrdersRulesTest (in launcher)",
          "    Checkstyle: maven-checkstyle-plugin in pom.xml",
          "    PMD: maven-pmd-plugin in pom.xml",
          "    Maven: ./mvnw (Maven Wrapper)",
          "  mvnd: on the PATH, so the architecture, Checkstyle and PMD checks run after each edit",
          "",
          "Wrote:",
          "  interlint.yaml",
          "",
        ].join("\n"),
      )
    })
  })

  it("treats the root as the project, as before, when the workspace holds no Maven project", async () => {
    writeFile("web/package.json", "{}")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no file under src/test/java contains @ArchTest, and the build in pom.xml has neither maven-checkstyle-plugin nor maven-pmd-plugin. Nothing was written.\n",
    })
    expect(existsSync(join(projectDir, "interlint.yaml"))).toBe(false)
  })

  it("says so and writes nothing when no Maven project of the workspace has anything to check", async () => {
    writeFile("orders/pom.xml", "<project/>")

    expect(await run("init")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "interlint: nothing to check: no Maven project has a file under src/test/java with @ArchTest, or maven-checkstyle-plugin or maven-pmd-plugin in its build (found: orders). Nothing was written.\n",
    })
  })
})
