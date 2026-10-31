import { isAbsolute, resolve, sep } from "node:path";
import type { FsApi } from "./fsapi.js";
import { isInside } from "./paths.js";
import { protectedReason } from "./domain/policy/protected.js";

export class RootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootsError";
  }
}

// A root may not be one of these directories, nor an ancestor of one of them.
const SYSTEM_EXACT = [
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libexec", "/media", "/mnt",
  "/nix", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var", "/Applications",
  "/Library", "/System", "/Users", "/Volumes", "/cores", "/private", "/private/etc", "/private/tmp",
  "/private/var", "/private/var/db", "/private/var/folders",
];

// A root may not lie inside these trees.
const SYSTEM_TREES = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libexec", "/proc", "/run", "/sbin", "/sys",
  "/usr", "/System", "/Library", "/Applications", "/opt/homebrew", "/private/etc", "/private/var/db",
  "/var/lib", "/var/db", "/var/log", "/var/run", "/var/spool", "/nix",
];

/** Validate and canonicalize configured roots. Throws RootsError naming the first offender. */
export async function validateRoots(
  rawRoots: readonly string[],
  opts: { homes: readonly string[]; fs: FsApi; cwd?: string },
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
    const abs = isAbsolute(raw) ? raw : resolve(opts.cwd ?? process.cwd(), raw);
    let real: string;
    try {
      real = await opts.fs.realpath(abs);
    } catch {
      throw new RootsError(`root does not exist: ${JSON.stringify(abs)}`);
    }
    const st = await opts.fs.lstat(real);
    if (!st.isDirectory()) throw new RootsError(`root is not a directory: ${JSON.stringify(real)}`);
    for (const candidate of new Set([abs, real])) {
      if (candidate === sep) throw new RootsError("refusing '/' as a root");
    }
    for (const h of homes) {
      if (real === h) throw new RootsError("refusing the home directory itself as a root; pass a subdirectory such as ~/projects");
      if (isInside(real, h)) throw new RootsError("refusing a root that contains the home directory");
    }
    for (const sys of SYSTEM_EXACT) {
      if (real === sys || abs === sys) throw new RootsError(`refusing system directory ${sys} as a root`);
      if (isInside(real, sys)) throw new RootsError(`refusing a root that contains system directory ${sys}`);
    }
    for (const tree of SYSTEM_TREES) {
      if (isInside(tree, real)) throw new RootsError(`refusing a root inside system location ${tree}`);
    }
    const reason = protectedReason(real, opts.homes);
    if (reason) throw new RootsError(`refusing a root in a protected location: ${reason}`);
    out.push(real);
  }
  const unique = [...new Set(out)].sort();
  for (let i = 0; i < unique.length; i++) {
    for (let j = 0; j < unique.length; j++) {
      if (i !== j && isInside(unique[i] as string, unique[j] as string)) {
        throw new RootsError("roots must not be nested inside each other");
      }
    }
  }
  return unique;
}
