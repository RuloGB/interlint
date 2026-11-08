import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { PdfPrinter } from "../../../application/metrics/ports.js"

/** Runs the browser with `args`: whether it ended well, and why not. */
export type BrowserRun = (browser: string, args: string[]) => { ok: true } | { ok: false; detail: string }

/** Long enough for a cold start of the browser on a slow machine. */
const PRINT_TIMEOUT_MS = 120_000

/** Where Chrome, Edge and Chromium are installed, most likely first. On Linux, the names they have on the PATH. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    return [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
    ].flatMap((parts) => roots.map((root) => join(root, ...parts)))
  }
  if (platform === "darwin") {
    const apps = ["/Applications", ...(env.HOME ? [join(env.HOME, "Applications")] : [])]
    return [
      ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
      ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
    ].flatMap((parts) => apps.map((folder) => (folder === "/Applications" ? `/Applications/${parts.join("/")}` : join(folder, ...parts))))
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"]
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)))
}

/** The first candidate that is there. */
export function findBrowser(candidates: string[], exists: (path: string) => boolean = isFile): string | undefined {
  return candidates.find(exists)
}

/**
 * Prints the HTML report with an installed Chrome, Edge or Chromium, headless. The browser prints into a temporary
 * folder of its own, so a failed print leaves nothing at `path` and an open browser window is not disturbed.
 */
export function headlessPdf(
  locate: () => string | undefined = () => findBrowser(browserCandidates(process.platform, process.env)),
  run: BrowserRun = runBrowser,
): PdfPrinter {
  return {
    print(html, path) {
      const browser = locate()
      if (browser === undefined) return { printed: false, reason: "no Chrome, Edge or Chromium was found" }
      const work = mkdtempSync(join(tmpdir(), "interlint-pdf-"))
      try {
        const page = join(work, "interlint-metrics.html")
        const pdf = join(work, "interlint-metrics.pdf")
        writeFileSync(page, html)
        const result = run(browser, [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          "--no-pdf-header-footer",
          `--user-data-dir=${join(work, "profile")}`,
          // Chromium will not start its sandbox as root, as in many containers.
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          `--print-to-pdf=${pdf}`,
          pathToFileURL(page).href,
        ])
        if (!existsSync(pdf)) {
          return { printed: false, reason: `browser could not print the report (${result.ok ? "it wrote no PDF" : result.detail})` }
        }
        mkdirSync(dirname(path), { recursive: true })
        copyFileSync(pdf, path)
        return { printed: true }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    },
  }
}

function runBrowser(browser: string, args: string[]): { ok: true } | { ok: false; detail: string } {
  const result = spawnSync(browser, args, { stdio: "ignore", timeout: PRINT_TIMEOUT_MS, windowsHide: true })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  return result.status === 0 ? { ok: true } : { ok: false, detail: `exit code ${result.status ?? result.signal}` }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
