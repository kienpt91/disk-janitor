// Observed facts handed to the discovery rules. They are plain values: the application layer
// gathers them through ports, the domain decides from them.

import { isInside } from "../shared/paths.js";

/**
 * Is a directory inside a git work tree? "unavailable": git state could not be established.
 * "untrusted": the repository's own configuration defines a command (`key`) that git could run
 * while answering questions about it, so nothing is asked of git inside it.
 */
export type RepoInfo =
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "untrusted"; key: string }
  | { state: "repo"; toplevel: string };

export type IgnoreState = "ignored" | "not-ignored" | "error";

/** Snapshot of the files processes hold open. */
export interface OpenFileIndex {
  /** False when lsof is missing or produced nothing usable: the check was not performed. */
  available: boolean;
  names: readonly string[];
}

/** First open path inside `path` (or equal to it), or null. */
export function openPathUnder(index: OpenFileIndex, path: string): string | null {
  for (const n of index.names) {
    if (isInside(path, n)) return n;
  }
  return null;
}

export interface WorktreeEntry {
  path: string;
  /** git's own prunable reason (its directory is gone), or null when the worktree is fine. */
  prunable: string | null;
}

/** One row of `docker system df`. */
export interface DockerDfRow {
  type: string;
  total: number;
  active: number;
  size: number | null;
  reclaimable: number | null;
}
