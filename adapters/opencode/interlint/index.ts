/**
 * Interlint adapter for OpenCode V2.
 *
 * When a session goes idle (the agent tried to finish), it runs `interlint check --when task-end`.
 * If a check fails, it resumes the session with the formatted failures so the agent fixes them,
 * up to MAX_CONSECUTIVE_BLOCKS times in a row.
 *
 * Install: copy this directory to `.opencode/plugins/interlint/` in the project.
 * The file has no runtime imports besides Node built-ins: `Plugin.define` from `@opencode/plugin`
 * is the identity function, so the plain definition below is equivalent.
 */
import { spawn } from "node:child_process"

export const MAX_CONSECUTIVE_BLOCKS = 3

export interface CheckRun {
  exitCode: number
  output: string
}

export type Decision = { action: "none" } | { action: "continue"; text: string } | { action: "report"; text: string }

/** Decides what to do with a task-end check result. Keeps one block counter per session. */
export class TaskEndGate {
  private readonly blocks = new Map<string, number>()

  decide(sessionID: string, run: CheckRun): Decision {
    if (run.exitCode === 0) {
      this.blocks.delete(sessionID)
      return { action: "none" }
    }
    if (run.exitCode !== 1) {
      this.blocks.delete(sessionID)
      return { action: "report", text: `Interlint could not run the checks (exit code ${run.exitCode}).\n\n${run.output}` }
    }

    const attempt = (this.blocks.get(sessionID) ?? 0) + 1
    if (attempt > MAX_CONSECUTIVE_BLOCKS) {
      this.blocks.delete(sessionID)
      return {
        action: "report",
        text: `Interlint: the checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts, so the task may end.\n\n${run.output}`,
      }
    }
    this.blocks.set(sessionID, attempt)
    return {
      action: "continue",
      text: `Interlint: the task cannot end yet (attempt ${attempt} of ${MAX_CONSECUTIVE_BLOCKS}).\n\n${run.output}`,
    }
  }
}

/** The part of the OpenCode V2 plugin context this adapter uses. */
interface PluginContext {
  location: { directory: string }
  options?: { command?: unknown }
  session: {
    synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>
  }
  event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }>
  }
}

export type RunChecks = (directory: string, command: string) => Promise<CheckRun>

export function createInterlintPlugin(runChecks: RunChecks = runInterlint) {
  return {
    id: "interlint",
    async setup(ctx: PluginContext) {
      const command = typeof ctx.options?.command === "string" ? ctx.options.command : "interlint"
      const gate = new TaskEndGate()
      const running = new Set<string>()
      const controller = new AbortController()

      const onIdle = async (sessionID: string) => {
        if (running.has(sessionID)) return
        running.add(sessionID)
        try {
          const decision = gate.decide(sessionID, await runChecks(ctx.location.directory, command))
          if (decision.action === "none") return
          await ctx.session.synthetic({
            sessionID,
            text: decision.text,
            description: "Interlint",
            resume: decision.action === "continue",
          })
        } finally {
          running.delete(sessionID)
        }
      }

      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = event.data?.sessionID
          if (event.type !== "session.idle" || !sessionID) continue
          onIdle(sessionID).catch((error) => console.error("[interlint]", error))
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.error("[interlint]", error)
      })

      return () => controller.abort()
    },
  }
}

/** Runs the Interlint CLI. Through the shell, so Windows finds `interlint.cmd`. */
function runInterlint(directory: string, command: string): Promise<CheckRun> {
  return new Promise((resolve) => {
    let output = ""
    const child = spawn(`${command} check --when task-end`, { cwd: directory, shell: true })
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))
    child.on("error", (error) => resolve({ exitCode: 2, output: `${output}${error.message}\n` }))
    child.on("close", (code) => resolve({ exitCode: code ?? 2, output }))
  })
}

export default createInterlintPlugin()
