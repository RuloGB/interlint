import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const XML_COMMENTS = /<!--[\s\S]*?-->/g
/**
 * Sections where a plugin's artifactId does not make the build run it: reporting is for the site, a dependency is a
 * jar on a classpath, `pluginManagement` only configures, and settings may name other plugins, as SpotBugs lists its
 * own there. A profile's `<build><plugins>` counts: the profile may be on by default or turned on with `-P`.
 */
const NOT_RUN = /<(reporting|dependencyManagement|dependencies|pluginManagement|configuration)>[\s\S]*?<\/\1>/g
const PARENT = /<parent>([\s\S]*?)<\/parent>/
const ARTIFACT_ID = /<artifactId>\s*([^<]*?)\s*<\/artifactId>/
const RELATIVE_PATH = /<relativePath>\s*([^<]*?)\s*<\/relativePath>|<relativePath\s*\/>/

/** A module of the build: the artifactId Maven names it by, as in `on project orders`, and its directory. */
export interface BuildModule {
  artifactId: string
  dir: string
}

/** The artifactId of the POM in `dir`, or nothing when it has none or cannot be read. */
export function buildModule(dir: string): BuildModule | undefined {
  const artifactId = artifactIdOf(readPom(join(dir, "pom.xml")))
  return artifactId ? { artifactId, dir } : undefined
}

/** The project's own artifactId, not its parent's. */
function artifactIdOf(xml: string): string | undefined {
  return ARTIFACT_ID.exec(xml.replace(PARENT, " "))?.[1]
}

/**
 * Whether the build of the module in `dir` may run the plugin: its POM, or a parent's it inherits from, declares it in
 * `<build><plugins>`, outside a profile or in one. A parent counts when it is the POM its `relativePath` names, `../pom.xml` by default, and that
 * POM has the parent's artifactId; a parent from a repository declares none of the project's plugins.
 */
export function runsPlugin(dir: string, artifactId: string): boolean {
  const declares = new RegExp(`<artifactId>\\s*${artifactId}\\s*</artifactId>`)
  const seen = new Set<string>()
  let pom: string | undefined = resolve(dir, "pom.xml")
  while (pom !== undefined && !seen.has(pom)) {
    seen.add(pom)
    const xml = readPom(pom)
    if (declares.test(xml.replace(PARENT, " ").replace(NOT_RUN, " "))) return true
    pom = parentPom(pom, xml)
  }
  return false
}

function parentPom(pom: string, xml: string): string | undefined {
  const parent = PARENT.exec(xml)?.[1]
  if (parent === undefined) return undefined
  const relativePath = RELATIVE_PATH.exec(parent)
  const path = relativePath === null ? ".." : (relativePath[1] ?? "")
  if (path === "") return undefined
  const target = resolve(dirname(pom), path)
  const candidate = target.endsWith(".xml") ? target : join(target, "pom.xml")
  const expected = ARTIFACT_ID.exec(parent)?.[1]
  return existsSync(candidate) && artifactIdOf(readPom(candidate)) === expected ? candidate : undefined
}

function readPom(pom: string): string {
  try {
    return readFileSync(pom, "utf8").replace(XML_COMMENTS, " ")
  } catch {
    return ""
  }
}
