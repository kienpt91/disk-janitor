// Eligibility: pure decisions about whether an observed directory may be offered as a Candidate.
// The application layer observes facts through ports and asks these functions; they never do IO.
// The refusal reasons are user-visible (they appear in the skipped list) and are part of the
// contract: tests and documentation quote them.

import { isInside } from "../shared/paths.js";
import { newDockerFinding, newFsFinding, type DockerFinding, type FsFinding } from "../model/candidate.js";
import { DAY_MS, type DetectorId, type ReportItem } from "../model/types.js";
import { protectedReason } from "../policy/protected.js";
import type { BuildOutputSpec, CacheLocation, Lockfile } from "./catalog.js";
import { openPathUnder, type DockerDfRow, type IgnoreState, type OpenFileIndex, type RepoInfo, type WorktreeEntry } from "./facts.js";
import type { TreeStats } from "./tree-analysis.js";

export type Decision<T> = { ok: true; value: T } | { ok: false; reason: string };

const accept = <T>(value: T): Decision<T> => ({ ok: true, value });
const refuse = <T = never>(reason: string): Decision<T> => ({ ok: false, reason });

// ---------------------------------------------------------------------------------------------
// Shared rules for every file system Candidate
// ---------------------------------------------------------------------------------------------

export type PathKind = "missing" | "symlink" | "directory" | "other";

export interface DirectoryFacts {
  kind: PathKind;
  dev: bigint;
  ino: bigint;
  mtimeMs: number;
}

export interface DirectoryContext {
  /** Canonical home directories used by the protected-path rules. */
  homes: readonly string[];
  /** Device of the root (or home, for caches) the candidate must stay on. */
  baseDev: bigint;
}

/** Why a path cannot even be examined as a Candidate, or null when it is a real, unprotected directory on the right device. */
export function directoryRefusal(path: string, dir: DirectoryFacts, ctx: DirectoryContext): string | null {
  if (dir.kind === "missing") return "cannot stat";
  if (dir.kind === "symlink") return "is a symlink (never followed)";
  if (dir.kind !== "directory") return "is not a directory";
  const prot = protectedReason(path, ctx.homes);
  if (prot) return prot;
  if (dir.dev !== ctx.baseDev) return "on a different file system than its root";
  return null;
}

/** How a detector describes the Candidates it offers. */
export interface CandidateRule {
  detector: DetectorId;
  /** Reject key material by extension too (build outputs). */
  strict: boolean;
  /** Candidates must be idle at least this long. */
  minAgeDays: number;
  reasonFor: (ageDays: number) => string;
  regenerate: string;
}

export interface FsAssessmentInput {
  rule: CandidateRule;
  path: string;
  directory: DirectoryFacts;
  tree: TreeStats;
  minSizeBytes: number;
  nowMs: number;
  /** Latest known activity outside the tree, ms. The newest mtime inside the tree is folded in. */
  activityMs: number;
  openFiles: OpenFileIndex;
}

/** Size, age and open-handle rules, then the validated Candidate. */
export function assessFsCandidate(input: FsAssessmentInput): Decision<FsFinding> {
  const { rule, path, directory, tree } = input;
  if (tree.size < input.minSizeBytes) return refuse(`below the minimum size of ${input.minSizeBytes} bytes`);
  const activity = Math.max(input.activityMs, tree.newestMtimeMs, directory.mtimeMs);
  const ageMs = input.nowMs - activity;
  const ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));
  if (ageMs < rule.minAgeDays * DAY_MS) return refuse(`activity ${ageDays} days ago, minimum age is ${rule.minAgeDays} days`);
  if (openPathUnder(input.openFiles, path)) return refuse("a process has files open inside it");
  return accept(
    newFsFinding({
      detector: rule.detector,
      path,
      dev: directory.dev,
      ino: directory.ino,
      size: tree.size,
      entries: tree.entries,
      mtimeMs: directory.mtimeMs,
      newestMtimeMs: tree.newestMtimeMs,
      ageDays,
      reason: rule.reasonFor(ageDays),
      regenerate: rule.regenerate,
    }),
  );
}

/** A repository that is unreadable or whose root escapes the configured Root makes its projects ineligible. */
export function repositoryRefusal(repo: RepoInfo, root: string): string | null {
  if (repo.state === "unavailable") return "inside a git repository but git state could not be read";
  if (repo.state === "repo" && !isInside(root, repo.toplevel)) return "its git repository root is outside the configured root";
  return null;
}

// ---------------------------------------------------------------------------------------------
// node_modules
// ---------------------------------------------------------------------------------------------

/** null: nothing to report (no node_modules here, or it is not a directory). */
export function nodeModulesPresence(kind: PathKind): Decision<void> | null {
  if (kind === "missing") return null;
  if (kind === "symlink") return refuse("node_modules is a symlink (never followed)");
  if (kind !== "directory") return null;
  return accept(undefined);
}

export interface FileFacts {
  isFile: boolean;
  mtimeMs: number;
}

export function packageJsonRefusal(packageJson: FileFacts | null): string | null {
  return packageJson && packageJson.isFile ? null : "no package.json next to it, so it is not a recognised project";
}

export interface FoundLockfile {
  lockfile: Lockfile;
  mtimeMs: number;
}

/** The first lockfile (in catalogue order) names the reinstall command. */
export function selectLockfile(found: readonly FoundLockfile[]): Decision<FoundLockfile> {
  const first = found[0];
  return first ? accept(first) : refuse("no lockfile, so a reinstall would not be reproducible");
}

export function worktreeCleanRefusal(clean: boolean | "error"): string | null {
  if (clean === "error") return "git status failed";
  return clean ? null : "git working tree has uncommitted or untracked changes";
}

export interface NodeModulesFacts {
  projectDir: string;
  lockfile: FoundLockfile;
  lockfiles: readonly FoundLockfile[];
  packageJsonMtimeMs: number;
  /** Newest mtime of the project's own sources, node_modules and .git excluded. */
  sourceNewestMs: number;
  repoState: RepoInfo["state"];
  staleDays: number;
}

export function nodeModulesActivityMs(f: Pick<NodeModulesFacts, "sourceNewestMs" | "packageJsonMtimeMs" | "lockfiles">): number {
  return Math.max(f.sourceNewestMs, f.packageJsonMtimeMs, ...f.lockfiles.map((l) => l.mtimeMs));
}

export function nodeModulesRule(f: NodeModulesFacts): CandidateRule {
  const gitNote = f.repoState === "repo" ? "git working tree clean" : "no git repository";
  return {
    detector: "node-modules",
    strict: false,
    minAgeDays: f.staleDays,
    reasonFor: (age) => `project untouched for ${age} days; package.json and ${f.lockfile.lockfile.name} present; ${gitNote}`,
    regenerate: `${f.lockfile.lockfile.regenerate} (in ${f.projectDir})`,
  };
}

// ---------------------------------------------------------------------------------------------
// Build outputs
// ---------------------------------------------------------------------------------------------

export function ignoreRefusal(state: IgnoreState): string | null {
  if (state === "ignored") return null;
  return state === "error" ? "git check-ignore failed" : "not git-ignored";
}

export function trackedFilesRefusal(tracked: boolean | "error"): string | null {
  if (tracked === false) return null;
  return tracked === "error" ? "git ls-files failed" : "contains files tracked by git";
}

/**
 * Without git, the project type must be identifiable: the first manifest of the spec present as a
 * regular file, else (Python caches) a sibling .py file. `regularFiles` are names of regular files
 * in the project directory.
 */
export function findManifest(spec: BuildOutputSpec, regularFiles: readonly string[]): Decision<string> {
  const present = new Set(regularFiles);
  for (const m of spec.manifests) if (present.has(m)) return accept(m);
  if (spec.pySibling) {
    for (const n of regularFiles) if (n.endsWith(".py")) return accept(n);
  }
  return refuse("no sibling manifest identifies the project type");
}

/** Names that could identify the project type for `spec`; the application stats only these. */
export function manifestNamesToCheck(spec: BuildOutputSpec, names: readonly string[]): string[] {
  const wanted = new Set(spec.manifests);
  return names.filter((n) => wanted.has(n) || (spec.pySibling === true && n.endsWith(".py")));
}

export const GIT_IGNORED_ORIGIN = "git-ignored and untracked";
export const manifestOrigin = (manifest: string): string => `allowlisted name next to ${manifest} (no git repository)`;

export function buildOutputRule(spec: BuildOutputSpec, origin: string, minAgeDays: number): CandidateRule {
  const label = spec.rel.join("/");
  return {
    detector: "build-output",
    strict: true,
    minAgeDays,
    reasonFor: (age) => `build output ${label}, nothing inside modified for ${age} days; ${origin}`,
    regenerate: spec.regenerate,
  };
}

// ---------------------------------------------------------------------------------------------
// Package caches
// ---------------------------------------------------------------------------------------------

export const CACHE_SYMLINK_REFUSAL = "a path component is a symlink (never followed)";
export const HOME_MISSING_WARNING = "home directory does not exist; package caches not scanned";

export function packageCacheRule(loc: CacheLocation, minAgeDays: number): CandidateRule {
  return {
    detector: "package-cache",
    strict: false,
    minAgeDays,
    reasonFor: (age) => `${loc.label} at its default location, nothing inside modified for ${age} days`,
    regenerate: loc.regenerate,
  };
}

// ---------------------------------------------------------------------------------------------
// Docker (report always; offer build cache and dangling images only with dockerApply)
// ---------------------------------------------------------------------------------------------

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Parse docker's human sizes such as "1.5GB", "800MB (66%)" or "0B". Returns null when unparseable. */
export function parseDockerSize(text: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)\b/.exec(text);
  if (!m) return null;
  const unit = UNITS[(m[2] as string).toLowerCase()];
  if (unit === undefined) return null;
  const value = Number(m[1]) * unit;
  return Number.isFinite(value) ? Math.round(value) : null;
}

export const DOCKER_DF_UNPARSEABLE = "unparseable docker system df output";

/** Parse `docker system df --format '{{json .}}'` output (one JSON object per line). Throws on garbage. */
export function parseDockerDf(stdout: string): DockerDfRow[] {
  const rows: DockerDfRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(DOCKER_DF_UNPARSEABLE);
    }
    if (raw === null || typeof raw !== "object") throw new Error(DOCKER_DF_UNPARSEABLE);
    const o = raw as Record<string, unknown>;
    const type = typeof o["Type"] === "string" ? o["Type"] : null;
    if (!type) throw new Error(DOCKER_DF_UNPARSEABLE);
    rows.push({
      type,
      total: Number(o["TotalCount"] ?? 0) || 0,
      active: Number(o["Active"] ?? 0) || 0,
      size: typeof o["Size"] === "string" ? parseDockerSize(o["Size"]) : null,
      reclaimable: typeof o["Reclaimable"] === "string" ? parseDockerSize(o["Reclaimable"]) : null,
    });
  }
  return rows;
}

/** Total bytes of `docker image ls --filter dangling=true --format '{{json .}}'` output; null when any line is not JSON. */
export function parseDanglingImageBytes(stdout: string): number | null {
  let total = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const size = typeof o["Size"] === "string" ? parseDockerSize(o["Size"]) : null;
      if (size !== null) total += size;
    } catch {
      return null;
    }
  }
  return total;
}

export function dockerUnavailableReport(notInstalled: boolean): ReportItem {
  return {
    detector: "docker",
    title: "docker unavailable",
    detail: notInstalled ? "the docker CLI was not found" : "docker system df failed (daemon not running?)",
  };
}

export function dockerUnparseableReport(message: string): ReportItem {
  return { detector: "docker", title: "docker output not understood", detail: message };
}

/** One informational line per docker resource type. */
export function dockerUsageReports(rows: readonly DockerDfRow[], dockerApply: boolean): ReportItem[] {
  return rows.map((r) => ({
    detector: "docker" as const,
    title: `docker ${r.type}`,
    detail: `${r.total} total, ${r.active} active; reclaimable ${r.reclaimable ?? "unknown"} bytes (report only${dockerApply ? "" : "; docker apply is off"})`,
    ...(r.size !== null ? { size: r.size } : {}),
  }));
}

export function offerBuildCache(rows: readonly DockerDfRow[], minSizeBytes: number): DockerFinding | null {
  const cache = rows.find((r) => r.type === "Build Cache");
  if (!cache || (cache.reclaimable ?? 0) < minSizeBytes) return null;
  return newDockerFinding(
    "build-cache",
    cache.reclaimable ?? 0,
    "unused Docker build cache (docker builder prune removes only cache not in use)",
    "docker rebuilds layers on the next build",
  );
}

export function offerDanglingImages(bytes: number | null, minSizeBytes: number): DockerFinding | null {
  if (bytes === null || bytes < minSizeBytes) return null;
  return newDockerFinding(
    "dangling-images",
    bytes,
    "dangling (untagged, unreferenced) images; docker image prune without -a removes only these. Size is an upper bound",
    "re-pull or rebuild the image if you still need it",
  );
}

// ---------------------------------------------------------------------------------------------
// Worktrees (report only)
// ---------------------------------------------------------------------------------------------

/** Parse `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends a record. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (cur) out.push(cur);
      cur = null;
    } else if (field.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: field.slice("worktree ".length), prunable: null };
    } else if (cur && (field === "prunable" || field.startsWith("prunable "))) {
      cur.prunable = field.slice("prunable".length).trim() || "prunable";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Worktrees git itself marks prunable (their directory is gone). This tool never removes or prunes
 * worktrees; the report tells the user which command to run themselves.
 */
export function prunableWorktreeReports(repoDir: string, entries: readonly WorktreeEntry[]): ReportItem[] {
  const out: ReportItem[] = [];
  for (const wt of entries) {
    if (wt.prunable === null) continue;
    out.push({
      detector: "git-worktrees",
      title: "prunable git worktree",
      detail: `repository ${repoDir}: ${wt.prunable}. Review, then run 'git worktree prune' yourself; disk-janitor never removes worktrees`,
      path: wt.path,
    });
  }
  return out;
}
