import * as fsp from "node:fs/promises";
import type { FileSystem } from "../../application/ports/common.js";

/** FileSystem adapter over node:fs/promises. Uses lstat only, so symlinks are never followed. */
export const nodeFs: FileSystem = {
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  readdir: (p) => fsp.readdir(p),
  realpath: (p) => fsp.realpath(p),
  rename: (from, to) => fsp.rename(from, to),
};
