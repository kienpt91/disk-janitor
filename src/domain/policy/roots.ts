import { sep } from "node:path";
import { isInside } from "../shared/paths.js";
import { protectedReason } from "./protected.js";

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

/**
 * Why a root (given as typed and as resolved by realpath) is not acceptable, or null.
 * `homes` are the canonical and literal home directories of the invoking user.
 */
export function rootViolation(abs: string, real: string, homes: readonly string[], protectedHomes: readonly string[]): string | null {
  for (const candidate of new Set([abs, real])) {
    if (candidate === sep) return "refusing '/' as a root";
  }
  for (const h of homes) {
    if (real === h) return "refusing the home directory itself as a root; pass a subdirectory such as ~/projects";
    if (isInside(real, h)) return "refusing a root that contains the home directory";
  }
  for (const sys of SYSTEM_EXACT) {
    if (real === sys || abs === sys) return `refusing system directory ${sys} as a root`;
    if (isInside(real, sys)) return `refusing a root that contains system directory ${sys}`;
  }
  for (const tree of SYSTEM_TREES) {
    if (isInside(tree, real)) return `refusing a root inside system location ${tree}`;
  }
  const reason = protectedReason(real, protectedHomes);
  if (reason) return `refusing a root in a protected location: ${reason}`;
  return null;
}

/** Sorted, de-duplicated roots; throws RootsError when one root contains another. */
export function normalizeRootSet(roots: readonly string[]): string[] {
  const unique = [...new Set(roots)].sort();
  for (let i = 0; i < unique.length; i++) {
    for (let j = 0; j < unique.length; j++) {
      if (i !== j && isInside(unique[i] as string, unique[j] as string)) {
        throw new RootsError("roots must not be nested inside each other");
      }
    }
  }
  return unique;
}
