import { ConfigError } from "../../../application/checking/ports.js"

/** Exit codes shared by every agent integration. */
export const EXIT = { passed: 0, violations: 1, error: 2 } as const

export interface Io {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The whole of stdin. Only hooks read it. */
  stdin?: () => Promise<string>
}

/** An error the user can fix from its message alone, so it is reported without a stack. */
export class UserFacingError extends Error {}

export class UsageError extends UserFacingError {}

export function reportError(error: unknown, io: Io) {
  if (error instanceof ConfigError || error instanceof UserFacingError) {
    io.stderr(`interlint: ${error.message}\n`)
  } else {
    // A crash is reported here so the caller picks the exit code: left to Node, it exits with 1,
    // which means violations to `check` callers.
    io.stderr(`interlint: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`)
  }
}
