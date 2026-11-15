import type { ReportReader } from "../../../application/checking/ports.js"
import { outputTail } from "../../../domain/command-output.js"

/**
 * Reads the result of a team command, such as its tests or `tsc --noEmit`, from its exit code alone: it reads no
 * file. 0 passes. A command that was not found or could not start gives no result, so the run is reported as failed,
 * not as a failure of the check. Any other code is one failure, with the end of the output as its text.
 */
export const exitCodeReader: ReportReader = {
  snapshot: () => new Map(),
  read: (_projectDir, _before, output, { exitCode, notFound }) => {
    if (exitCode === 0) return { found: true, failures: [] }
    if (notFound) return { found: false, failures: [] }
    const text = output.trim() === "" ? "(it printed nothing)" : outputTail(output)
    return { found: true, failures: [{ title: `the command failed (exit code ${exitCode})`, violations: [{ text }] }] }
  },
}
