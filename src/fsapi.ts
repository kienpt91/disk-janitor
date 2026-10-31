import type { BigIntStats } from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * The few file system operations that decide what is inspected and what is moved.
 * Everything that touches candidates goes through this interface so tests can inject
 * races (swaps between validation and rename) and device boundaries.
 */
export interface FsApi {
  lstat(path: string): Promise<BigIntStats>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
}

export const nodeFs: FsApi = {
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  readdir: (p) => fsp.readdir(p),
  realpath: (p) => fsp.realpath(p),
  rename: (from, to) => fsp.rename(from, to),
};

export function isDir(st: BigIntStats): boolean {
  return st.isDirectory();
}

export async function lstatOrNull(fs: FsApi, path: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}
