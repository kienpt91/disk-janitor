import { prefixes } from "../domain/shared/paths.js";
import type { FileStat, FileSystem } from "./ports/common.js";

export async function lstatOrNull(fs: FileSystem, path: string): Promise<FileStat | null> {
  try {
    return await fs.lstat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/**
 * Walk the chain of components of `p` and return the first one that is a symlink or is not a
 * directory. Canonical paths come from realpath, so any symlink found here was introduced after
 * the path was recorded.
 */
export async function findSymlinkInChain(fs: FileSystem, p: string, includeSelf: boolean): Promise<string | null> {
  const chain = prefixes(p);
  const limit = includeSelf ? chain.length : chain.length - 1;
  for (let i = 0; i < limit; i++) {
    const cur = chain[i] as string;
    const st = await fs.lstat(cur);
    if (st.isSymbolicLink()) return cur;
    if (!st.isDirectory() && i < chain.length - 1) return cur;
  }
  return null;
}
