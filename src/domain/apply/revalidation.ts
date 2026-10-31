// Revalidation: before anything is moved, every file-system Candidate is compared with what the
// Plan recorded. "Planned" is the Candidate; "observed" is what the application layer saw just
// now. Anything that differs is a problem and aborts the whole Apply. The checks for one
// Candidate form a pipeline whose stages need progressively more expensive observations, so the
// caller feeds them one by one and stops at the first problem (see CandidateRevalidation).

import { baseFor, type Base } from "../policy/bases.js";
import { protectedReason } from "../policy/protected.js";
import type { FsCandidate, ConfigCore } from "../model/types.js";
import { isCanonicalAbsolute, isInside } from "../shared/paths.js";

export const MAX_PROBLEMS = 50;

/** lstat of one entry, never following links. */
export interface ObservedNode {
  dev: bigint;
  ino: bigint;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtimeMs: number;
}

/** Result of walking the path components looking for a symlink or a non-directory. */
export type ChainFact = { kind: "clean" } | { kind: "link" } | { kind: "unreadable"; code: string };

/** Size, entry count and newest mtime found by re-walking the tree, or why the tree is refused. */
export type ObservedTree = { ok: true; size: number; entries: number; newestMtimeMs: number } | { ok: false; reason: string };

/** What a Plan, its configuration and the Quarantine contribute to the comparison. */
export interface RevalidationContext {
  config: Pick<ConfigCore, "roots" | "home" | "detectors">;
  /** When the Plan was made: nothing may be newer. */
  planCreatedAt: number;
  /** st_dev of the Quarantine items directory: rename cannot cross devices. */
  itemsDevice: bigint;
}

export const PROBLEM = {
  overlap: "contains another candidate",
  notCanonical: "path is not canonical",
  outsideRoots: "outside the configured roots",
  chainLink: "a symlink or non-directory appeared in the path",
  disappeared: "path or its root disappeared",
  rootNotDirectory: "its root is not a real directory any more",
  nowSymlink: "is now a symlink",
  notDirectory: "is no longer a directory",
  identity: "device or inode changed since the plan was made",
  otherDeviceThanRoot: "is on a different file system than its root",
  otherDeviceThanQuarantine: "is on a different file system than the quarantine; rename cannot cross devices and copying is never done",
  modified: "directory was modified after the plan was made",
  contentsChanged: "contents changed since the plan was made",
  contentsNewer: "contents are newer than the plan",
  openHandle: "a process has files open inside it",
} as const;

/** Collects the problems of all Candidates of one Plan, capped at MAX_PROBLEMS. */
export class Revalidation {
  private readonly found: string[] = [];

  constructor(
    readonly context: RevalidationContext,
    readonly candidates: readonly FsCandidate[],
  ) {}

  get problems(): readonly string[] {
    return this.found;
  }

  get ok(): boolean {
    return this.found.length === 0;
  }

  add(c: Pick<FsCandidate, "id" | "path">, why: string): void {
    if (this.found.length < MAX_PROBLEMS) this.found.push(`${c.id} ${c.path}: ${why}`);
  }

  /** The pipeline of the Candidate at `position` in the Plan. */
  candidate(position: number): CandidateRevalidation {
    const c = this.candidates[position];
    if (!c) throw new RangeError(`no candidate at position ${position}`);
    return new CandidateRevalidation(this, c, position);
  }
}

/**
 * The staged comparison of one Candidate. `overlap` never stops the pipeline; every other stage
 * returns true when the Candidate may proceed to the next one and false once a problem was
 * recorded (the caller then skips the remaining stages for this Candidate).
 */
export class CandidateRevalidation {
  private base: Base | null = null;

  constructor(
    private readonly run: Revalidation,
    readonly planned: FsCandidate,
    private readonly position: number,
  ) {}

  /** Stage 0: no other Candidate lies inside this one. Records a problem per overlapping Candidate. */
  overlap(): void {
    this.run.candidates.forEach((other, j) => {
      if (j !== this.position && isInside(this.planned.path, other.path)) this.run.add(this.planned, PROBLEM.overlap);
    });
  }

  /** Stage 1: the path is canonical, under a configured base, and not protected. */
  location(): boolean {
    const c = this.planned;
    if (!isCanonicalAbsolute(c.path)) return this.fail(PROBLEM.notCanonical);
    const base = baseFor(this.run.context.config, c.path);
    if (!base) return this.fail(PROBLEM.outsideRoots);
    const prot = protectedReason(c.path, [this.run.context.config.home]);
    if (prot) return this.fail(prot);
    this.base = base;
    return true;
  }

  /** The base directory found by `location` (the application layer stats it). */
  get baseDir(): string {
    if (!this.base) throw new Error("location() must succeed before baseDir is read");
    return this.base.dir;
  }

  /** Stage 2: no symlink or non-directory in the path chain. */
  chain(fact: ChainFact): boolean {
    if (fact.kind === "unreadable") return this.fail(`cannot inspect the path (${fact.code})`);
    if (fact.kind === "link") return this.fail(PROBLEM.chainLink);
    return true;
  }

  /** Stage 3: identity, type and device of the directory and its base. `null` means it could not be read. */
  node(node: ObservedNode | null, base: ObservedNode | null): boolean {
    const c = this.planned;
    if (!node || !base) return this.fail(PROBLEM.disappeared);
    if (!base.isDirectory || base.isSymbolicLink) return this.fail(PROBLEM.rootNotDirectory);
    if (node.isSymbolicLink) return this.fail(PROBLEM.nowSymlink);
    if (!node.isDirectory) return this.fail(PROBLEM.notDirectory);
    if (node.dev.toString() !== c.dev || node.ino.toString() !== c.ino) return this.fail(PROBLEM.identity);
    if (node.dev !== base.dev) return this.fail(PROBLEM.otherDeviceThanRoot);
    if (node.dev !== this.run.context.itemsDevice) return this.fail(PROBLEM.otherDeviceThanQuarantine);
    if (node.mtimeMs !== c.mtimeMs || node.mtimeMs > this.run.context.planCreatedAt) return this.fail(PROBLEM.modified);
    return true;
  }

  /** Stage 4: the tree below has exactly the size, entry count and newest mtime that were planned. */
  tree(tree: ObservedTree): boolean {
    const c = this.planned;
    if (!tree.ok) return this.fail(tree.reason);
    if (tree.size !== c.size || tree.entries !== c.entries || tree.newestMtimeMs !== c.newestMtimeMs) return this.fail(PROBLEM.contentsChanged);
    if (tree.newestMtimeMs > this.run.context.planCreatedAt) return this.fail(PROBLEM.contentsNewer);
    return true;
  }

  /** Stage 5: no process has a file open inside (`openPath` is the first open path found, if any). */
  open(openPath: string | null): boolean {
    if (openPath !== null) return this.fail(PROBLEM.openHandle);
    return true;
  }

  private fail(why: string): false {
    this.run.add(this.planned, why);
    return false;
  }
}

/**
 * The cheap check made right before each rename. Returns the reason the Candidate may no longer
 * be moved, or null. `node` is null when the path could not be read.
 */
export function quickRecheckProblem(c: Pick<FsCandidate, "dev" | "ino">, chain: ChainFact, node: ObservedNode | null): string | null {
  if (chain.kind === "unreadable") return "path disappeared";
  if (chain.kind === "link") return PROBLEM.chainLink;
  if (!node) return "path disappeared";
  if (node.isSymbolicLink || !node.isDirectory) return "is no longer a real directory";
  if (node.dev.toString() !== c.dev || node.ino.toString() !== c.ino) return "device or inode changed";
  return null;
}

/**
 * Did something other than the planned directory arrive in Quarantine? `landed` is what lstat
 * found at the destination after the rename (null when nothing could be read).
 */
export function swappedBeforeRename(c: Pick<FsCandidate, "dev" | "ino">, landed: ObservedNode | null): boolean {
  return !landed || landed.isSymbolicLink || !landed.isDirectory || landed.dev.toString() !== c.dev || landed.ino.toString() !== c.ino;
}
