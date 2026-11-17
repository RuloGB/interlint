#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { claudeCodeSettingsFiles } from "./adapters/driven/agents/claude-code-settings.js"
import { transcriptModel } from "./adapters/driven/agents/claude-code-transcript.js"
import { codexHookFiles } from "./adapters/driven/agents/codex-hooks.js"
import { copilotHookFiles } from "./adapters/driven/agents/copilot-hooks.js"
import { copilotTranscriptModel } from "./adapters/driven/agents/copilot-transcript.js"
import { openCodePluginFiles } from "./adapters/driven/agents/opencode-plugin-files.js"
import { depcruiseReader } from "./adapters/driven/depcruise/report-reader.js"
import { eslintOnFiles } from "./adapters/driven/eslint/eslint-scope.js"
import { eslintReader } from "./adapters/driven/eslint/report-reader.js"
import { isDirectory } from "./adapters/driven/fs/directory-lookup.js"
import { diskProjectFiles, readProjectFile } from "./adapters/driven/fs/project-files.js"
import { diskProtectedFiles } from "./adapters/driven/fs/protected-files.js"
import { diskReportFile } from "./adapters/driven/fs/report-file.js"
import { removeBrokenClasses } from "./adapters/driven/maven/broken-classes.js"
import { checkstyleOnFiles } from "./adapters/driven/maven/checkstyle-scope.js"
import { scanMavenProjects } from "./adapters/driven/maven/project-scan.js"
import { archUnitReader } from "./adapters/driven/maven/reports/archunit-reader.js"
import { jacocoReader } from "./adapters/driven/maven/reports/jacoco-reader.js"
import { mavenQualityReader } from "./adapters/driven/maven/reports/quality-reader.js"
import { findsNpxTool } from "./adapters/driven/npm/package-bin.js"
import { scanNpmProjects } from "./adapters/driven/npm/project-scan.js"
import { findsCommand, runCommand } from "./adapters/driven/process/command-runner.js"
import { exitCodeReader } from "./adapters/driven/process/exit-code-reader.js"
import { lookupExecutable } from "./adapters/driven/process/executable-lookup.js"
import { fileSessionPauses, fileStopCounter, fileSubagentFiles } from "./adapters/driven/state/agent-state.js"
import { fileChangeTracker } from "./adapters/driven/state/change-tracker.js"
import { headlessPdf } from "./adapters/driven/browser/headless-pdf.js"
import { fileMetrics, fileMetricsSource, fileSessionMetrics } from "./adapters/driven/state/file-metrics.js"
import { interlintVersion } from "./adapters/driven/state/interlint-version.js"
import { filePendingEdits } from "./adapters/driven/state/pending-edits.js"
import { withProjectLock } from "./adapters/driven/state/project-lock.js"
import { fileProtectedBaselines } from "./adapters/driven/state/protected-baselines.js"
import { stateLocation } from "./adapters/driven/state/user-state.js"
import { CONFIG_FILE, loadConfig, yamlConfigFile } from "./adapters/driven/yaml-config/config.js"
import { type CliDeps, runCli } from "./adapters/driving/cli/cli.js"
import type { Io } from "./adapters/driving/cli/cli-io.js"
import type { CheckProjectDeps } from "./application/checking/check-project.js"

/** Wires the use cases to their adapters. This file is the only place that knows both. */
const checking: CheckProjectDeps = {
  loadConfig,
  run: runCommand,
  readers: {
    archunit: archUnitReader,
    maven: mavenQualityReader,
    jacoco: jacocoReader,
    eslint: eslintReader,
    depcruise: depcruiseReader,
    "exit-code": exitCodeReader,
  },
  hasExecutable: lookupExecutable,
  lock: withProjectLock,
  changes: fileChangeTracker(),
  hasDirectory: isDirectory,
  editScopes: { maven: checkstyleOnFiles, eslint: eslintOnFiles },
  removeBrokenClasses,
  pending: filePendingEdits(),
  metrics: fileMetrics(),
  protection: { files: diskProtectedFiles, baselines: fileProtectedBaselines() },
}

const agents = {
  opencode: openCodePluginFiles,
  "claude-code": claudeCodeSettingsFiles,
  copilot: copilotHookFiles,
  codex: codexHookFiles,
}

const DEPS: CliDeps = {
  checking,
  feedback: {
    checking,
    subagentFiles: fileSubagentFiles,
    stops: fileStopCounter,
    transcriptModel,
    pauses: fileSessionPauses,
    sessionMetrics: fileSessionMetrics(),
  },
  copilotTranscriptModel,
  setup: {
    scan: scanMavenProjects,
    scanNpm: scanNpmProjects,
    files: diskProjectFiles,
    config: yamlConfigFile,
    agents,
    hasExecutable: lookupExecutable,
  },
  doctor: {
    nodeVersion: () => process.versions.node,
    version: interlintVersion,
    configFile: CONFIG_FILE,
    loadConfig,
    readFile: readProjectFile,
    hasDirectory: isDirectory,
    hasExecutable: lookupExecutable,
    findsCommand: (command, cwd) => findsCommand(command, cwd),
    findsNpxTool,
    agents,
    files: diskProjectFiles,
    state: stateLocation,
    protectedFiles: diskProtectedFiles,
  },
  metrics: { source: fileMetricsSource(), reportFile: diskReportFile, pdf: headlessPdf(), now: () => new Date() },
  version: interlintVersion,
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
