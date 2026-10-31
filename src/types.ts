export const DETECTOR_IDS = ["node-modules", "build-output", "package-cache", "docker", "git-worktrees"] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

export const PLAN_VERSION = 1;

/** A directory that apply may move into quarantine. */
export interface FsCandidate {
  kind: "fs";
  id: string;
  detector: DetectorId;
  /** Canonical absolute path (realpath, no symlinks in the chain). */
  path: string;
  type: "dir";
  /** st_dev and st_ino as decimal strings (they can exceed 2^53). */
  dev: string;
  ino: string;
  /** Disk usage in bytes (allocated blocks, hard-linked files counted once). */
  size: number;
  entries: number;
  /** mtime of the directory itself, ms since epoch. */
  mtimeMs: number;
  /** newest mtime of anything inside the candidate, ms since epoch. */
  newestMtimeMs: number;
  ageDays: number;
  reason: string;
  regenerate: string;
}

/** A Docker resource that apply may prune through the docker CLI (irreversible, no quarantine). */
export interface DockerCandidate {
  kind: "docker";
  id: string;
  detector: "docker";
  resource: "build-cache" | "dangling-images";
  size: number;
  reason: string;
  regenerate: string;
}

export type Candidate = FsCandidate | DockerCandidate;

/** Informational finding that this tool never acts on. */
export interface ReportItem {
  detector: DetectorId;
  title: string;
  detail: string;
  size?: number;
  path?: string;
}

export interface SkippedItem {
  detector: DetectorId;
  path: string;
  reason: string;
}

/** The parts of the configuration that are bound into a plan (and so into its digest). */
export interface ConfigCore {
  roots: string[];
  home: string;
  detectors: DetectorId[];
  dockerApply: boolean;
  staleDays: number;
  buildMinAgeDays: number;
  cacheMinAgeDays: number;
  minSizeBytes: number;
  maxDepth: number;
  maxCandidates: number;
  maxEntriesPerCandidate: number;
}

export interface Plan {
  version: typeof PLAN_VERSION;
  id: string;
  createdAt: number;
  configDigest: string;
  config: ConfigCore;
  candidates: Candidate[];
  reports: ReportItem[];
  digest: string;
}

export const DAY_MS = 86_400_000;
