import { isAbsolute, relative, resolve, sep } from "node:path"

/** The changed files as `/`-separated paths relative to the project. Files outside it are left out. */
export function projectFiles(cwd: string, projectDir: string, files: string[]): string[] {
  return files
    .map((file) => relative(projectDir, resolve(cwd, file)))
    .filter((path) => path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    .map((path) => path.split(sep).join("/"))
}
