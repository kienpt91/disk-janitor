import { isAbsolute, normalize, sep } from "node:path";

/** True when `child` is `parent` or lies below it. Both must be normalized absolute paths. */
export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/** A canonical path is absolute, normalized, has no NUL, no trailing separator and no `..` segments. */
export function isCanonicalAbsolute(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (p.includes("\0")) return false;
  if (!isAbsolute(p)) return false;
  if (normalize(p) !== p) return false;
  if (p.length > 1 && p.endsWith(sep)) return false;
  return !p.split(sep).includes("..");
}

export function assertCanonicalAbsolute(p: string, what = "path"): void {
  if (!isCanonicalAbsolute(p)) throw new Error(`${what} is not a canonical absolute path`);
}

/** Every prefix of an absolute path, from the first component to the full path. */
export function prefixes(p: string): string[] {
  const parts = p.split(sep).filter((x) => x.length > 0);
  const out: string[] = [];
  let cur = "";
  for (const part of parts) {
    cur += sep + part;
    out.push(cur);
  }
  return out;
}
