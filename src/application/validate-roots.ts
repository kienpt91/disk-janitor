import { isAbsolute, resolve } from "node:path";
import { normalizeRootSet, RootsError, rootViolation } from "../domain/policy/roots.js";
import type { FileSystem } from "./ports/common.js";

/** Validate and canonicalize configured roots. Throws RootsError naming the first offender. */
export async function validateRoots(
  rawRoots: readonly string[],
  opts: { homes: readonly string[]; fs: FileSystem; cwd?: string },
): Promise<string[]> {
  if (rawRoots.length === 0) {
    throw new RootsError("no roots configured: pass at least one --root <dir> (there is no default)");
  }
  const homes: string[] = [];
  for (const h of opts.homes) {
    homes.push(h);
    try {
      homes.push(await opts.fs.realpath(h));
    } catch {
      // a home that does not exist cannot contain the root
    }
  }
  const out: string[] = [];
  for (const raw of rawRoots) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw new RootsError("root is empty or contains a NUL byte");
    if (!isAbsolute(raw) && opts.cwd === undefined) throw new RootsError("a relative root needs a working directory to resolve against");
    const abs = isAbsolute(raw) ? raw : resolve(opts.cwd as string, raw);
    let real: string;
    try {
      real = await opts.fs.realpath(abs);
    } catch {
      throw new RootsError(`root does not exist: ${JSON.stringify(abs)}`);
    }
    const st = await opts.fs.lstat(real);
    if (!st.isDirectory()) throw new RootsError(`root is not a directory: ${JSON.stringify(real)}`);
    const violation = rootViolation(abs, real, homes, opts.homes);
    if (violation) throw new RootsError(violation);
    out.push(real);
  }
  return normalizeRootSet(out);
}
