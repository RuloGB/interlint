import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { BrokenClassRemover } from "../../../application/checking/ports.js"
import { moduleDirs } from "./modules.js"

/**
 * The constant the Eclipse compiler writes into a class it compiled with errors, as the message of the error each
 * method that failed to compile throws. javac never writes a class with errors.
 */
const ECLIPSE_PROBLEM = Buffer.from("Unresolved compilation problem")

const CLASS_DIRS = [join("target", "classes"), join("target", "test-classes")]

/** Deletes the classes compiled with errors in `target/classes` and `target/test-classes` of the project and its modules. */
export const removeBrokenClasses: BrokenClassRemover = (projectDir) =>
  moduleDirs(projectDir)
    .flatMap((module) => CLASS_DIRS.flatMap((dir) => classFilesIn(join(module, dir))))
    .filter((file) => isBroken(file) && removed(file))

function classFilesIn(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return classFilesIn(path)
    return entry.isFile() && entry.name.endsWith(".class") ? [path] : []
  })
}

function isBroken(file: string): boolean {
  try {
    return readFileSync(file).includes(ECLIPSE_PROBLEM)
  } catch {
    return false
  }
}

/** A class the IDE holds open cannot be deleted on Windows; the check then runs with it, as before. */
function removed(file: string): boolean {
  try {
    rmSync(file)
    return true
  } catch {
    return false
  }
}
