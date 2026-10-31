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

/** Counts the stops blocked in a row, per session and per subagent. */
export interface StopCounter {
  /** 0 when nothing was counted. */
  read(agent: AgentRef): number
  save(agent: AgentRef, count: number): void
  clear(agent: AgentRef): void
}
