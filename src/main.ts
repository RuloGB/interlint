#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { claudeCodeSettingsFiles } from "./adapters/driven/agents/claude-code-settings.js"
import { openCodePluginFiles } from "./adapters/driven/agents/opencode-plugin-files.js"
import { isDirectory } from "./adapters/driven/fs/directory-lookup.js"
import { diskProjectFiles } from "./adapters/driven/fs/project-files.js"
import { checkstyleOnFiles } from "./adapters/driven/maven/checkstyle-scope.js"
import { scanMavenProjects } from "./adapters/driven/maven/project-scan.js"
import { archUnitReader } from "./adapters/driven/maven/reports/archunit-reader.js"
import { mavenQualityReader } from "./adapters/driven/maven/reports/quality-reader.js"
import { runCommand } from "./adapters/driven/process/command-runner.js"
import { lookupExecutable } from "./adapters/driven/process/executable-lookup.js"
import { fileStopCounter, fileSubagentFiles } from "./adapters/driven/state/agent-state.js"
import { fileChangeTracker } from "./adapters/driven/state/change-tracker.js"
import { withProjectLock } from "./adapters/driven/state/project-lock.js"
import { loadConfig, yamlConfigFile } from "./adapters/driven/yaml-config/config.js"
import { type CliDeps, runCli } from "./adapters/driving/cli/cli.js"
import type { Io } from "./adapters/driving/cli/cli-io.js"
import type { CheckProjectDeps } from "./application/checking/check-project.js"

/** Wires the use cases to their adapters. This file is the only place that knows both. */
const checking: CheckProjectDeps = {
  loadConfig,
  run: runCommand,
  readers: { archunit: archUnitReader, maven: mavenQualityReader },
  hasExecutable: lookupExecutable,
  lock: withProjectLock,
  changes: fileChangeTracker(),
  hasDirectory: isDirectory,
  editScopes: { maven: checkstyleOnFiles },
}

const DEPS: CliDeps = {
  checking,
  feedback: { checking, subagentFiles: fileSubagentFiles, stops: fileStopCounter },
  setup: {
    scan: scanMavenProjects,
    files: diskProjectFiles,
    config: yamlConfigFile,
    agents: { opencode: openCodePluginFiles, "claude-code": claudeCodeSettingsFiles },
    hasExecutable: lookupExecutable,
  },
}

export { EXIT, type Io } from "./adapters/driving/cli/cli-io.js"

export function main(args: string[], io: Io): Promise<number> {
  return runCli(args, io, DEPS)
}

function isEntryPoint() {
  const entry = process.argv[1]
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

if (isEntryPoint()) {
  const exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString("utf8")
    },
  })
  process.exitCode = exitCode
}
