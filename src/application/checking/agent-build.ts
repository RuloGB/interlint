import { LOCK_WAIT_NOTE_MS, lockWaitNote, startsServer } from "../../domain/agent-build.js"
import type { ProjectLock, ShellCommand, ShellRunner } from "./ports.js"

export interface AgentBuildDeps {
  lock: ProjectLock
  runShell: ShellRunner
  now: () => number
}

/**
 * Runs a build the agent started itself while holding the project lock, so it never shares `target/` with Interlint's
 * checks: it waits for the checks that run, and the checks wait for it. A server never ends, so it waits for the checks
 * and runs without the lock. `tell` gets the note of a build that waited, before the build's own output.
 */
export async function runAgentBuild(
  projectDir: string,
  command: ShellCommand,
  deps: AgentBuildDeps,
  tell: (note: string) => void,
): Promise<number> {
  const startedAt = deps.now()
  const waited = () => {
    const waitedMs = deps.now() - startedAt
    if (waitedMs >= LOCK_WAIT_NOTE_MS) tell(lockWaitNote(waitedMs))
  }
  if (startsServer(command.text)) {
    await deps.lock(projectDir, async () => waited())
    return deps.runShell(command)
  }
  return deps.lock(projectDir, async () => {
    waited()
    return deps.runShell(command)
  })
}
