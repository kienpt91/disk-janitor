import { cachePaths } from "./detectors/packageCache.js";
import { isInside } from "./paths.js";
import type { ConfigCore } from "./domain/model/types.js";

export type Base = { kind: "root" | "cache"; dir: string };

/**
 * Which allowed base a path lives under: a configured root, or (package-cache detector enabled)
 * exactly one of the documented cache locations below the configured home. Null means refuse.
 */
export function baseFor(core: Pick<ConfigCore, "roots" | "home" | "detectors">, path: string): Base | null {
  for (const root of core.roots) {
    if (isInside(root, path)) return { kind: "root", dir: root };
  }
  if (core.detectors.includes("package-cache") && cachePaths(core.home).includes(path)) {
    return { kind: "cache", dir: core.home };
  }
  return null;
}
