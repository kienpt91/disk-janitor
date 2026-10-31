// TreeAnalysis: the rules that decide whether a directory tree may be a Candidate and how much
// disk it uses. The traversal is IO and lives in the application layer; it feeds this accumulator
// one batch of names and one entry at a time. Nothing here follows a symlink.

import { contentNameReason } from "../policy/protected.js";

export interface TreeStats {
  /** Disk usage in bytes: allocated blocks, hard-linked files counted once. */
  size: number;
  entries: number;
  newestMtimeMs: number;
}

export type TreeResult = { ok: true; stats: TreeStats } | { ok: false; reason: string };

export interface TreeAnalysisOptions {
  /** The device every entry must live on. */
  dev: bigint;
  maxEntries: number;
  /** Reject key material by extension (build outputs); node_modules and caches use false. */
  strict: boolean;
  maxDepth: number;
}

export const DEFAULT_MAX_TREE_DEPTH = 100;

/** What a traversal observed about the root of the tree. */
export interface RootFacts {
  blocks: bigint;
  mtimeMs: number;
}

export type EntryKind = "directory" | "file" | "symlink" | "other";

/** What a traversal observed about one entry (from lstat). */
export interface EntryFacts {
  kind: EntryKind;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  blocks: bigint;
  mtimeMs: number;
}

const BLOCK_BYTES = 512;

export const unreadableDirectory = (code: string | undefined): string => `cannot read directory (${code ?? "error"})`;
export const changedWhileScanning = (code: string | undefined): string => `changed while scanning (${code ?? "error"})`;

/**
 * Accumulates facts about a tree and refuses it as soon as a rule is broken: crossing a file
 * system boundary, special files, secret or database names, names that are not valid UTF-8, too
 * many entries, excessive depth, or hard-linked files whose link group is not entirely inside.
 * The first refusal is final; later calls return it unchanged.
 */
export class TreeAnalysis {
  private readonly opts: TreeAnalysisOptions;
  private readonly links = new Map<bigint, { nlink: bigint; seen: number }>();
  private size: number;
  private entries = 0;
  private newest: number;
  private refusal: string | null = null;

  constructor(root: RootFacts, opts: Omit<TreeAnalysisOptions, "maxDepth"> & { maxDepth?: number }) {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_TREE_DEPTH;
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 0) throw new RangeError("maxEntries must be a non-negative integer");
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new RangeError("maxDepth must be a non-negative integer");
    if (root.blocks < 0n) throw new RangeError("blocks must not be negative");
    this.opts = { dev: opts.dev, maxEntries: opts.maxEntries, strict: opts.strict, maxDepth };
    this.size = Number(root.blocks) * BLOCK_BYTES;
    this.newest = root.mtimeMs;
  }

  get refusedReason(): string | null {
    return this.refusal;
  }

  /** Record a refusal that the traversal found itself (an unreadable directory, a race). */
  refuse(reason: string): string {
    this.refusal ??= reason;
    return this.refusal;
  }

  /**
   * A batch of directory entry names is about to be inspected: check every name, then count them
   * against the entry limit. Returns the refusal reason or null to continue.
   */
  admitNames(names: readonly string[]): string | null {
    if (this.refusal) return this.refusal;
    for (const name of names) {
      if (name.includes("\ufffd")) return this.refuse("contains a name that is not valid UTF-8");
      const why = contentNameReason(name, this.opts.strict);
      if (why) return this.refuse(why);
    }
    this.entries += names.length;
    if (this.entries > this.opts.maxEntries) return this.refuse(`more than ${this.opts.maxEntries} entries`);
    return null;
  }

  /** One entry directly inside a directory at `parentDepth` (the root's children have depth 0). */
  add(entry: EntryFacts, parentDepth: number): string | null {
    if (this.refusal) return this.refusal;
    if (entry.dev !== this.opts.dev) return this.refuse("crosses a file system boundary");
    if (entry.mtimeMs > this.newest) this.newest = entry.mtimeMs;
    const bytes = Number(entry.blocks) * BLOCK_BYTES;
    switch (entry.kind) {
      case "directory":
        if (parentDepth + 1 > this.opts.maxDepth) return this.refuse("nested deeper than the depth limit");
        this.size += bytes;
        return null;
      case "file":
      case "symlink": {
        if (entry.nlink > 1n) {
          const group = this.links.get(entry.ino);
          if (group) group.seen++;
          else {
            this.links.set(entry.ino, { nlink: entry.nlink, seen: 1 });
            this.size += bytes;
          }
        } else {
          this.size += bytes;
        }
        return null;
      }
      case "other":
        return this.refuse("contains a device, socket or fifo");
    }
  }

  /** The verdict once the whole tree was fed in. */
  finish(): TreeResult {
    if (this.refusal) return { ok: false, reason: this.refusal };
    for (const g of this.links.values()) {
      if (BigInt(g.seen) < g.nlink) return { ok: false, reason: this.refuse("contains hard links shared with files outside the candidate") };
    }
    return { ok: true, stats: { size: this.size, entries: this.entries, newestMtimeMs: this.newest } };
  }
}
