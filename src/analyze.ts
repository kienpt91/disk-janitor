import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import type { FsApi } from "./fsapi.js";
import { contentNameReason } from "./protect.js";

export interface TreeStats {
  /** Disk usage in bytes: allocated blocks, hard-linked files counted once. */
  size: number;
  entries: number;
  newestMtimeMs: number;
}

export type TreeResult = { ok: true; stats: TreeStats } | { ok: false; reason: string };

export interface AnalyzeOptions {
  /** The device every entry must live on. */
  dev: bigint;
  maxEntries: number;
  /** Reject key material by extension (build outputs); node_modules and caches use false. */
  strict: boolean;
  maxTreeDepth?: number;
}

const CHUNK = 128;

/**
 * Inspect a candidate tree without following a single symlink. Refuses (with a reason) when the
 * tree crosses a file system boundary, contains special files, nested repositories, secret
 * names, database markers, names that cannot be represented, too many entries, or hard-linked
 * files whose link group is not entirely inside the tree.
 */
export async function analyzeTree(fs: FsApi, root: string, rootStat: BigIntStats, opts: AnalyzeOptions): Promise<TreeResult> {
  const maxDepth = opts.maxTreeDepth ?? 100;
  const links = new Map<bigint, { nlink: bigint; seen: number }>();
  let size = Number(rootStat.blocks) * 512;
  let entries = 0;
  let newest = Number(rootStat.mtimeMs);
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0) {
    const { path, depth } = stack.pop() as { path: string; depth: number };
    let names: string[];
    try {
      names = await fs.readdir(path);
    } catch (e) {
      return { ok: false, reason: `cannot read directory (${(e as NodeJS.ErrnoException).code ?? "error"})` };
    }
    for (let i = 0; i < names.length; i += CHUNK) {
      const slice = names.slice(i, i + CHUNK);
      for (const name of slice) {
        if (name.includes("\ufffd")) return { ok: false, reason: "contains a name that is not valid UTF-8" };
        const nameReason = contentNameReason(name, opts.strict);
        if (nameReason) return { ok: false, reason: nameReason };
      }
      entries += slice.length;
      if (entries > opts.maxEntries) return { ok: false, reason: `more than ${opts.maxEntries} entries` };
      let stats: BigIntStats[];
      try {
        stats = await Promise.all(slice.map((name) => fs.lstat(join(path, name))));
      } catch (e) {
        return { ok: false, reason: `changed while scanning (${(e as NodeJS.ErrnoException).code ?? "error"})` };
      }
      for (let k = 0; k < slice.length; k++) {
        const st = stats[k] as BigIntStats;
        const name = slice[k] as string;
        if (st.dev !== opts.dev) return { ok: false, reason: "crosses a file system boundary" };
        const mtime = Number(st.mtimeMs);
        if (mtime > newest) newest = mtime;
        if (st.isDirectory()) {
          if (depth + 1 > maxDepth) return { ok: false, reason: "nested deeper than the depth limit" };
          size += Number(st.blocks) * 512;
          stack.push({ path: join(path, name), depth: depth + 1 });
        } else if (st.isFile() || st.isSymbolicLink()) {
          if (st.nlink > 1n) {
            const g = links.get(st.ino);
            if (g) g.seen++;
            else {
              links.set(st.ino, { nlink: st.nlink, seen: 1 });
              size += Number(st.blocks) * 512;
            }
          } else {
            size += Number(st.blocks) * 512;
          }
        } else {
          return { ok: false, reason: "contains a device, socket or fifo" };
        }
      }
    }
  }
  for (const g of links.values()) {
    if (BigInt(g.seen) < g.nlink) return { ok: false, reason: "contains hard links shared with files outside the candidate" };
  }
  return { ok: true, stats: { size, entries, newestMtimeMs: newest } };
}

/** Newest mtime of regular files and directories under `dir`, skipping excluded names. Bounded. */
export async function newestSourceMtime(
  fs: FsApi,
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
      let st: BigIntStats;
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
