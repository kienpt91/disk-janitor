import { join } from "node:path";
import { TreeAnalysis, changedWhileScanning, unreadableDirectory, type EntryFacts, type TreeResult } from "../domain/discovery/tree-analysis.js";
import type { FileStat, FileSystem } from "./ports/common.js";

export type { TreeResult, TreeStats } from "../domain/discovery/tree-analysis.js";

export interface InspectOptions {
  /** The device every entry must live on. */
  dev: bigint;
  maxEntries: number;
  /** Reject key material by extension (build outputs); node_modules and caches use false. */
  strict: boolean;
  maxTreeDepth?: number;
}

const CHUNK = 128;

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

export function entryFacts(st: FileStat): EntryFacts {
  return {
    kind: st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other",
    dev: st.dev,
    ino: st.ino,
    nlink: st.nlink,
    blocks: st.blocks,
    mtimeMs: Number(st.mtimeMs),
  };
}

/**
 * Walk a candidate tree without following a single symlink and feed what is found to a
 * TreeAnalysis, which decides (see its rules) whether the tree is acceptable and how large it is.
 */
export async function inspectTree(fs: FileSystem, root: string, rootStat: FileStat, opts: InspectOptions): Promise<TreeResult> {
  const analysis = new TreeAnalysis(
    { blocks: rootStat.blocks, mtimeMs: Number(rootStat.mtimeMs) },
    { dev: opts.dev, maxEntries: opts.maxEntries, strict: opts.strict, ...(opts.maxTreeDepth !== undefined ? { maxDepth: opts.maxTreeDepth } : {}) },
  );
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0) {
    const { path, depth } = stack.pop() as { path: string; depth: number };
    let names: string[];
    try {
      names = await fs.readdir(path);
    } catch (e) {
      analysis.refuse(unreadableDirectory(codeOf(e)));
      return analysis.finish();
    }
    for (let i = 0; i < names.length; i += CHUNK) {
      const slice = names.slice(i, i + CHUNK);
      if (analysis.admitNames(slice)) return analysis.finish();
      let stats: FileStat[];
      try {
        stats = await Promise.all(slice.map((name) => fs.lstat(join(path, name))));
      } catch (e) {
        analysis.refuse(changedWhileScanning(codeOf(e)));
        return analysis.finish();
      }
      for (let k = 0; k < slice.length; k++) {
        const facts = entryFacts(stats[k] as FileStat);
        if (analysis.add(facts, depth)) return analysis.finish();
        if (facts.kind === "directory") stack.push({ path: join(path, slice[k] as string), depth: depth + 1 });
      }
    }
  }
  return analysis.finish();
}

/** Newest mtime of regular files and directories under `dir`, skipping excluded names. Bounded. */
export async function newestSourceMtime(
  fs: FileSystem,
  dir: string,
  dev: bigint,
  skipNames: ReadonlySet<string>,
  maxEntries: number,
): Promise<{ ok: true; newestMs: number } | { ok: false; reason: string }> {
  let newest = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let names: string[];
    try {
      names = await fs.readdir(cur);
    } catch {
      return { ok: false, reason: "cannot read project directory" };
    }
    for (const name of names) {
      if (skipNames.has(name)) continue;
      if (++count > maxEntries) return { ok: false, reason: `project has more than ${maxEntries} source entries` };
      let st: FileStat;
      try {
        st = await fs.lstat(join(cur, name));
      } catch {
        return { ok: false, reason: "project changed while scanning" };
      }
      if (st.dev !== dev) continue;
      const m = Number(st.mtimeMs);
      if (m > newest) newest = m;
      if (st.isDirectory()) stack.push(join(cur, name));
    }
  }
  return { ok: true, newestMs: newest };
}
