import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ReportFile } from "../../../application/metrics/ports.js"

/** Writes a report where the user asked, making its directory when it is missing. */
export const diskReportFile: ReportFile = {
  exists: (path) => existsSync(path),
  write(path, content) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  },
}
