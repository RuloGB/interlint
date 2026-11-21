import type { SessionMetric } from "../../domain/metric.js"

/** Who an agent hook fires for: a session, and one of its subagents when `agentId` is set. */
export interface AgentRef {
  sessionId: string
  agentId?: string
}

/**
 * Remembers the files a subagent changed, relative to the project, so its stop checks the projects that hold them.
 * Each hook run is its own process, so the store outlives it.
 */
export interface SubagentFiles {
  /** Records nothing for the main agent: its stop checks every changed project anyway. */
  record(agent: AgentRef, files: string[]): void
  /** The files the subagent changed since its checks last passed: none for the main agent or a read-only subagent. */
  list(agent: AgentRef): string[]
  /** Forgets the subagent's files: its checks passed, or the main agent answers for them now. */
  forget(agent: AgentRef): void
}

/**
 * Remembers the fingerprint of each project's files when a subagent started, by the project's `dir` or `.` for the
 * root, so its stop can tell the projects it changed by any means, such as a shell command. Each hook run is its own
 * process, so the store outlives it.
 */
export interface SubagentSnapshots {
  save(agent: AgentRef, fingerprints: Readonly<Record<string, string>>): void
  /** None for a subagent whose start was not seen, such as with hooks written by an older Interlint. */
  read(agent: AgentRef): Readonly<Record<string, string>> | undefined
}

/**
 * The model of the last answer in a Claude Code session's transcript, or in the transcript of its subagent `agentId`.
 * None when it cannot be read.
 */
export type TranscriptModel = (transcript: { path: string; agentId?: string }) => string | undefined

/**
 * The sessions the user paused Interlint in (F26). Each hook run is its own process, so the store outlives it. A
 * session it cannot read counts as active, so a lost record never leaves a session without checks.
 */
export interface SessionPauses {
  isPaused(session: string): boolean
  pause(session: string): void
  resume(session: string): void
}

/** Keeps a session's pause or resume in the project's metrics. A metric it cannot keep is lost, and it never throws. */
export type SessionMetrics = (projectDir: string, metric: SessionMetric) => void

/** Counts the stops blocked in a row, per session and per subagent. */
export interface StopCounter {
  /** 0 when nothing was counted. */
  read(agent: AgentRef): number
  save(agent: AgentRef, count: number): void
  clear(agent: AgentRef): void
}
