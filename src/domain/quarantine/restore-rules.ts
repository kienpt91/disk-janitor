// The rules that decide whether a quarantined item may be put back. Facts about the world are
// gathered by the application layer; this decides. Reasons are shown to the human verbatim.

import { dirname } from "node:path";
import { baseFor } from "../policy/bases.js";
import { protectedReason } from "../policy/protected.js";
import type { ManifestEntry, ManifestScope } from "./manifest.js";
import { isRestorableEntry } from "./manifest.js";

/** What was observed about the stored item inside Quarantine (lstat, never following links). */
export type StoredItemFact =
  | { present: false }
  | { present: true; directory: boolean; symlink: boolean; dev: bigint; ino: bigint };

/** What was observed about the chain of directories above the original path. */
export type ParentFact = "ok" | "missing" | "link";

/** What was observed at the original path itself. */
export type OriginalFact = "absent" | "present" | "uninspectable";

export interface RestoreFacts {
  item: StoredItemFact;
  parent: ParentFact;
  original: OriginalFact;
}

/** The directory whose chain must be free of symlinks before an item is renamed into it. */
export function restoreParent(entry: Pick<ManifestEntry, "originalPath">): string {
  return dirname(entry.originalPath);
}

/**
 * Why `entry` must not be restored now, or null when it may. Checks run in a fixed order: status,
 * the stored item, the recorded roots, protected paths, the parent chain, then the original path
 * (restore never overwrites).
 */
export function restoreRefusal(scope: ManifestScope, entry: ManifestEntry, facts: RestoreFacts): string | null {
  if (!isRestorableEntry(entry)) return `status is ${entry.status}`;
  if (!facts.item.present) return "quarantined item is missing";
  if (facts.item.symlink || !facts.item.directory) return "quarantined item is not a directory any more";
  if (facts.item.ino.toString() !== entry.ino || facts.item.dev.toString() !== entry.dev) {
    return "quarantined item changed (inode mismatch)";
  }
  if (!baseFor(scope, entry.originalPath)) return "original path is outside the roots recorded in the manifest";
  const prot = protectedReason(entry.originalPath, [scope.home]);
  if (prot) return prot;
  if (facts.parent === "missing") return "parent directory does not exist";
  if (facts.parent === "link") return "a parent path component is a symlink or not a directory";
  if (facts.original === "uninspectable") return "cannot inspect the original path";
  if (facts.original === "present") return "something already exists at the original path; refusing to overwrite";
  return null;
}
