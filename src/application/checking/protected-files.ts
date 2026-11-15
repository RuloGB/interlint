import type { Config } from "../../domain/check.js"
import type { AgentContext, CheckMetric } from "../../domain/metric.js"
import {
  hasProtectedChanges,
  isProtected,
  normalized,
  PROTECTED_CHECK,
  type ProtectedChanges,
  protectedChanges,
  protectedPatterns,
  withApprovedEdits,
} from "../../domain/protected-files.js"
import type { MetricsSink, ProjectLock, ProtectedBaselines, ProtectedFiles } from "./ports.js"

/** The adapters that keep the protected files' fingerprint. */
export interface ProtectionDeps {
  files: ProtectedFiles
  baselines: ProtectedBaselines
}

/** The protected files among `files`, relative to the project. */
export function protectedAmong(config: Config, files: readonly string[]): string[] {
  const patterns = protectedPatterns(config.protected)
  return files.filter((file) => isProtected(file, patterns))
}

/**
 * When the agent's session starts: keeps the protected files as they are now, unless the session already has a
 * fingerprint, so resuming or compacting a session never accepts a change made in it.
 */
export function startProtection(projectDir: string, config: Config, session: string, deps: ProtectionDeps): void {
  if (deps.baselines.read(projectDir, session) !== undefined) return
  deps.baselines.save(projectDir, session, deps.files(projectDir, protectedPatterns(config.protected)))
}

/**
 * After the agent's edit tool changed `files`, in the main agent's `session`: the protected ones it changed without
 * asking the user, for a warning. A file new since the session started is not one: it cannot block the task end.
 * When the tool `asked` the user first, as Interlint's pre-edit hook makes it, the edit ran because the user approved
 * it, so those files' fingerprint is renewed instead.
 */
export async function protectedEdit(
  projectDir: string,
  config: Config,
  files: readonly string[],
  session: string | undefined,
  asked: boolean,
  deps: ProtectionDeps,
  lock: ProjectLock,
): Promise<string[]> {
  const edited = protectedAmong(config, files)
  if (edited.length === 0) return []
  if (!asked) {
    const before = session === undefined ? undefined : deps.baselines.read(projectDir, session)
    if (before === undefined) return edited
    const kept = Object.keys(before).map((path) => path.toLowerCase())
    return edited.filter((file) => kept.includes(normalized(file).toLowerCase()))
  }
  if (session === undefined) return []
  // Under the lock, so the hooks of two edits in a row never drop each other's renewal.
  await lock(projectDir, async () => {
    const before = deps.baselines.read(projectDir, session)
    if (before === undefined) return
    const now = deps.files(projectDir, protectedPatterns(config.protected))
    deps.baselines.save(projectDir, session, withApprovedEdits(before, now, edited))
  })
  return []
}

/**
 * At the main agent's task end: the protected files changed since its session started without the user's approval.
 * None for a subagent, whose main agent's task end checks them, and none without a session or its fingerprint.
 */
export function protectedTaskEnd(
  projectDir: string,
  config: Config,
  agent: AgentContext | undefined,
  deps: ProtectionDeps,
): ProtectedChanges | undefined {
  const session = agent?.session
  if (session === undefined || agent?.subagent === true) return undefined
  const before = deps.baselines.read(projectDir, session)
  if (before === undefined) return undefined
  const changes = protectedChanges(before, deps.files(projectDir, protectedPatterns(config.protected)))
  return hasProtectedChanges(changes) ? changes : undefined
}

/** Keeps the protected files the task end found changed in the metrics, with who changed them. Never throws. */
export async function recordProtectedChanges(
  projectDir: string,
  config: Config,
  changes: ProtectedChanges,
  agent: AgentContext | undefined,
  metrics: MetricsSink,
  lock: ProjectLock,
): Promise<void> {
  if (config.metrics === false) return
  const metric: CheckMetric = {
    when: "task-end",
    check: PROTECTED_CHECK,
    report: "protected",
    result: "violations",
    durationMs: 0,
    violations: [
      ...changes.changed.map((file) => ({ rule: "protected file changed", file })),
      ...changes.deleted.map((file) => ({ rule: "protected file deleted", file })),
    ],
    ...agent,
  }
  try {
    await lock(projectDir, async () => metrics(projectDir, [metric]))
  } catch {
    // Lost on purpose: the task end's result never depends on its metrics.
  }
}
