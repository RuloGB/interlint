import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/** Directories that never hold a Maven module: sources, build output and Node dependencies. Hidden ones neither. */
const NOT_MODULES = new Set(["src", "target", "node_modules"])

const XML_COMMENTS = /<!--[\s\S]*?-->/g
/** A profile may be off, so the modules it adds are not part of every build. */
const PROFILES = /<profiles>[\s\S]*?<\/profiles>/g
const MODULES_ELEMENT = /<modules>([\s\S]*?)<\/modules>/g
const MODULE_ELEMENT = /<module>\s*([^<]*?)\s*<\/module>/g

/**
 * The project directory and every directory with its own `pom.xml` below it, at any depth, to find the reports a
 * build left. The whole tree is searched, so a module added by a profile, or below a directory without `pom.xml`,
 * is found too. Symbolic links are not followed.
 */
export function moduleDirs(projectDir: string): string[] {
  return [projectDir, ...pomDirsBelow(projectDir)]
}

function pomDirsBelow(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NOT_MODULES.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const child = join(dir, name)
      return [...(existsSync(join(child, "pom.xml")) ? [child] : []), ...pomDirsBelow(child)]
    })
}

/**
 * The project directory and the modules its build declares, at any depth: each `<module>` of `pom.xml`, then the
 * modules of that module. Modules in a profile, outside the project or without a POM are left out, so a stray
 * `pom.xml`, such as a sample's, never makes a project a reactor.
 */
export function declaredModules(projectDir: string): string[] {
  const root = resolve(projectDir)
  const found = [root]
  const visit = (dir: string, pom: string) => {
    for (const path of modulePaths(pom)) {
      const target = resolve(dir, path)
      const isPom = path.endsWith(".xml") && isFile(target)
      const module = isPom ? dirname(target) : target
      const modulePom = isPom ? target : join(target, "pom.xml")
      const inside = !relative(root, module).startsWith("..")
      if (!inside || found.includes(module) || !isFile(modulePom)) continue
      found.push(module)
      visit(module, modulePom)
    }
  }
  visit(root, join(root, "pom.xml"))
  return found
}

function modulePaths(pom: string): string[] {
  let xml: string
  try {
    xml = readFileSync(pom, "utf8").replace(XML_COMMENTS, " ").replace(PROFILES, " ")
  } catch {
    return []
  }
  return [...xml.matchAll(MODULES_ELEMENT)].flatMap((modules) =>
    [...(modules[1] ?? "").matchAll(MODULE_ELEMENT)].map((module) => module[1] ?? "").filter((path) => path !== ""),
  )
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
