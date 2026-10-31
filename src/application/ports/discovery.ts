// Ports of the discovery context: what the DiscoverCandidates use case may ask the outside world.
// Adapters live in src/infrastructure/process.

import type { DockerCandidate } from "../../domain/model/types.js";
import type { DockerDfRow, IgnoreState, OpenFileIndex, RepoInfo, WorktreeEntry } from "../../domain/discovery/facts.js";

/** Read-only questions about git repositories. Repositories are untrusted input. */
export interface GitPort {
  /**
   * Is `dir` inside a git work tree? "unavailable" when git cannot be run but a .git entry exists
   * between `dir` and `ceiling`; "none" when git says no or no .git entry exists and git is missing.
   * "untrusted" when the repository's local configuration defines a command git could run (see
   * domain/discovery/repo-config); no other method may be called for such a repository.
   */
  repoInfo(dir: string, ceiling: string): Promise<RepoInfo>;
  /** Is `path` ignored by the repository containing `repoDir`? */
  isIgnored(repoDir: string, path: string): Promise<IgnoreState>;
  /** True when git tracks at least one file at or below `path`. */
  hasTrackedFiles(repoDir: string, path: string): Promise<boolean | "error">;
  /** No changes and no untracked, non-ignored files at or below `dir`. */
  worktreeClean(dir: string): Promise<boolean | "error">;
  /** Linked worktrees of the repository at `repoDir`; null when git could not list them. */
  worktrees(repoDir: string): Promise<WorktreeEntry[] | null>;
}

/** Which paths do processes hold open right now (best effort). */
export interface OpenFilesPort {
  snapshot(): Promise<OpenFileIndex>;
}

export type DockerUsage =
  | { status: "ok"; rows: DockerDfRow[] }
  | { status: "unavailable"; notInstalled: boolean }
  | { status: "unparseable"; message: string };

export interface DockerPruneOutcome {
  ok: boolean;
  /** Tail of the CLI output (stdout on success, stderr or the error otherwise). */
  detail: string;
}

/** The docker CLI. Only fixed argument lists from the domain catalogue are ever executed. */
export interface DockerPort {
  usage(): Promise<DockerUsage>;
  /** Sum of dangling image sizes; null when it could not be determined. */
  danglingImageBytes(): Promise<number | null>;
  prune(resource: DockerCandidate["resource"]): Promise<DockerPruneOutcome>;
}
