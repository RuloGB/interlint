import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browserCandidates, findBrowser, headlessPdf } from "../src/adapters/driven/browser/headless-pdf.js"
import type { MetricsDeps } from "../src/application/metrics/show-metrics.js"
import { writeMetricsReport } from "../src/application/metrics/show-metrics.js"
import type { MetricEvent } from "../src/domain/metric.js"
import { main } from "../src/main.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "interlint-metrics-pdf-"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const EVENT: MetricEvent = {
  v: 1,
  at: "2026-11-05T10:00:00.000Z",
  interlint: "1.11.1",
  projectKey: "k",
  project: "shop",
  when: "edit",
  check: "pmd",
  report: "maven",
  result: "violations",
  durationMs: 1000,
  violations: [{ rule: "UnusedPrivateField", type: "pmd" }],
}

function deps(printed: { html: string; path: string }[], print: MetricsDeps["pdf"]["print"] | undefined = undefined): MetricsDeps {
  return {
    source: { read: () => ({ events: [EVENT], unreadable: 0 }), location: () => "somewhere" },
    reportFile: { exists: (path) => existsSync(path), write: () => expect.fail("a PDF is not written as text") },
    pdf: {
      print:
        print ??
        ((html, path) => {
          printed.push({ html, path })
          return { printed: true }
        }),
    },
    now: () => new Date("2026-11-08T00:00:00.000Z"),
  }
}

describe("writing the report as a PDF", () => {
  it("prints the HTML report, with its charts, to the path and says where", () => {
    const printed: { html: string; path: string }[] = []
    const path = join(dir, "report.pdf")

    const outcome = writeMetricsReport({ scope: { all: true } }, { path, format: "pdf", force: false }, deps(printed))

    expect(outcome).toEqual({ status: "written", text: `Wrote the metrics report to ${path}` })
    expect(printed).toHaveLength(1)
    expect(printed[0]?.path).toBe(path)
    expect(printed[0]?.html).toContain("<h2>Violations by type</h2>")
    expect(printed[0]?.html).toContain("<svg ")
  })

  it("says why when it cannot print, and writes nothing", () => {
    const outcome = writeMetricsReport(
      { scope: { all: true } },
      { path: join(dir, "report.pdf"), format: "pdf", force: false },
      deps([], () => ({ printed: false, reason: "no Chrome, Edge or Chromium was found" })),
    )

    expect(outcome).toEqual({ status: "no-pdf", reason: "no Chrome, Edge or Chromium was found" })
  })

  it("never replaces an existing PDF without force", () => {
    const path = join(dir, "report.pdf")
    writeFileSync(path, "mine")
    const printed: { html: string; path: string }[] = []

    expect(writeMetricsReport({ scope: { all: true } }, { path, format: "pdf", force: false }, deps(printed))).toEqual({ status: "exists" })
    expect(printed).toEqual([])
    expect(writeMetricsReport({ scope: { all: true } }, { path, format: "pdf", force: true }, deps(printed)).status).toBe("written")
  })
})

describe("finding a browser", () => {
  it("looks for Chrome, Edge and Chromium where Windows installs them", () => {
    const candidates = browserCandidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    })

    expect(candidates).toContain(join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"))
    expect(candidates).toContain(join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"))
    expect(candidates).toContain(join("C:\\Users\\me\\AppData\\Local", "Chromium", "Application", "chrome.exe"))
  })

  it("looks in the applications folders on macOS, and on the PATH on Linux", () => {
    expect(browserCandidates("darwin", { HOME: "/Users/me" })).toEqual(
      expect.arrayContaining([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        join("/Users/me", "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]),
    )
    expect(browserCandidates("linux", { PATH: ["/usr/bin", "/opt/bin"].join(delimiter) })).toEqual(
      expect.arrayContaining([join("/usr/bin", "google-chrome"), join("/opt/bin", "chromium"), join("/usr/bin", "microsoft-edge")]),
    )
  })

  it("takes the first candidate that exists", () => {
    expect(findBrowser(["/a", "/b", "/c"], (path) => path !== "/a")).toBe("/b")
    expect(findBrowser(["/a"], () => false)).toBeUndefined()
  })
})

describe("printing with a headless browser", () => {
  it("prints the HTML from a file and copies the PDF to the path, making its directory", () => {
    const path = join(dir, "out", "report.pdf")
    let args: string[] = []
    const printer = headlessPdf(
      () => "browser",
      (_browser, given) => {
        args = given
        const pdf = given.find((arg) => arg.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length) as string
        writeFileSync(pdf, "%PDF-1.4")
        return { ok: true }
      },
    )

    expect(printer.print("<p>report</p>", path)).toEqual({ printed: true })
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.4")
    expect(args).toEqual(expect.arrayContaining(["--headless", "--no-pdf-header-footer"]))
    expect(args.at(-1)).toMatch(/^file:\/\/.*\.html$/)
  })

  it("says no browser was found", () => {
    const printer = headlessPdf(() => undefined, () => expect.fail("nothing to run"))

    expect(printer.print("<p>report</p>", join(dir, "report.pdf"))).toEqual({
      printed: false,
      reason: "no Chrome, Edge or Chromium was found",
    })
  })

  it("prints in a work folder beside the path, not in the system's temporary folder, and removes it", () => {
    const path = join(dir, "report.pdf")
    let pdf = ""
    const printer = headlessPdf(
      () => "browser",
      (_browser, given) => {
        pdf = given.find((arg) => arg.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length) as string
        writeFileSync(pdf, "%PDF-1.4")
        return { ok: true }
      },
    )

    printer.print("<p>report</p>", path)

    expect(dirname(dirname(pdf))).toBe(dir)
    expect(readdirSync(dir)).toEqual(["report.pdf"])
  })

  it("does not copy a PDF the browser left when it failed, such as half a file after a timeout", () => {
    const path = join(dir, "report.pdf")
    const printer = headlessPdf(
      () => "browser",
      (_browser, given) => {
        writeFileSync(given.find((arg) => arg.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length) as string, "%PDF-1.")
        return { ok: false, detail: "timed out" }
      },
    )

    expect(printer.print("<p>report</p>", path)).toEqual({ printed: false, reason: "browser could not print the report (timed out)" })
    expect(readdirSync(dir)).toEqual([])
  })

  it("says the browser wrote no PDF when it ended well with an empty file", () => {
    const printer = headlessPdf(
      () => "browser",
      (_browser, given) => {
        writeFileSync(given.find((arg) => arg.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length) as string, "")
        return { ok: true }
      },
    )

    expect(printer.print("<p>report</p>", join(dir, "report.pdf"))).toEqual({
      printed: false,
      reason: "browser could not print the report (it wrote no PDF)",
    })
  })

  it("says the browser did not write the PDF, and leaves no file", () => {
    const path = join(dir, "report.pdf")
    const printer = headlessPdf(() => "browser", () => ({ ok: false, detail: "timed out" }))

    expect(printer.print("<p>report</p>", path)).toEqual({ printed: false, reason: "browser could not print the report (timed out)" })
    expect(existsSync(path)).toBe(false)
  })
})

describe("interlint metrics report --format pdf", () => {
  it.skipIf(process.platform === "darwin")("fails with a clear message and proposes HTML when there is no browser", async () => {
    const state = join(dir, "state")
    vi.stubEnv("LOCALAPPDATA", state)
    vi.stubEnv("XDG_STATE_HOME", state)
    vi.stubEnv("PROGRAMFILES", join(dir, "none"))
    vi.stubEnv("PROGRAMFILES(X86)", join(dir, "none"))
    vi.stubEnv("PATH", join(dir, "none"))
    const { fileMetrics } = await import("../src/adapters/driven/state/file-metrics.js")
    fileMetrics(join(state, "interlint", "metrics"), () => new Date(EVENT.at))(dir, [
      { when: "edit", check: "pmd", report: "maven", result: "passed", durationMs: 1 },
    ])
    let stderr = ""

    const exitCode = await main(["metrics", "report", "--format", "pdf", "--cwd", dir], {
      cwd: dir,
      stdout: () => {},
      stderr: (text) => void (stderr += text),
    })

    expect(exitCode).toBe(2)
    expect(stderr).toBe(
      "interlint: could not write a PDF: no Chrome, Edge or Chromium was found. Use --format html and print it to PDF from a browser.\n",
    )
    expect(existsSync(join(dir, "interlint-metrics.pdf"))).toBe(false)
  })
})
