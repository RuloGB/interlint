import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { type DoctorDeps, diagnose, formatDiagnosis, hasErrors } from "../../../application/diagnosis/diagnose.js"
import { EXIT, type Io, UsageError } from "./cli-io.js"

/** Tells whether Interlint works in the project: exits 1 on any error, and 0 with only warnings. */
export function doctor(args: string[], io: Io, deps: DoctorDeps): number {
  const { values } = parseDoctorArgs(args)
  const projectDir = resolve(io.cwd, values.cwd ?? ".")
  if (!existsSync(projectDir)) throw new UsageError(`${projectDir} does not exist`)
  const diagnosis = diagnose(projectDir, deps)
  io.stdout(`Interlint doctor in ${projectDir}\n\n${formatDiagnosis(diagnosis)}`)
  return hasErrors(diagnosis) ? EXIT.violations : EXIT.passed
}

function parseDoctorArgs(args: string[]) {
  try {
    return parseArgs({ args, options: { cwd: { type: "string" } }, strict: true, allowPositionals: false })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
