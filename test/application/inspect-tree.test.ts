import { describe, expect, it } from "vitest";
import { inspectTree, newestSourceMtime } from "../../src/application/inspect-tree.js";
import type { FileSystem } from "../../src/application/ports/common.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Wrap a file system so chosen operations fail. */
function failing(base: FileSystem, o: { readdir?: (p: string) => string | null; lstat?: (p: string) => string | null }): FileSystem {
  return {
    ...base,
    lstat: async (p) => {
      const code = o.lstat?.(p);
      if (code) throw errno(code);
      return base.lstat(p);
    },
    readdir: async (p) => {
      const code = o.readdir?.(p);
      if (code) throw errno(code);
      return base.readdir(p);
    },
    realpath: (p) => base.realpath(p),
    rename: (a, b) => base.rename(a, b),
  };
}

async function inspect(fs: FileSystem, root: string, o: { maxEntries?: number; strict?: boolean; maxTreeDepth?: number } = {}) {
  const st = await fs.lstat(root);
  return inspectTree(fs, root, st, { dev: st.dev, maxEntries: o.maxEntries ?? 10_000, strict: o.strict ?? false, ...(o.maxTreeDepth !== undefined ? { maxTreeDepth: o.maxTreeDepth } : {}) });
}

describe("inspectTree", () => {
  it("sums blocks and counts every entry below the root", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/a", { bytes: 1024, mtimeMs: 50 }).writeFile("/t/d/b", { bytes: 512, mtimeMs: 90 });
    expect(await inspect(mem, "/t")).toEqual({ ok: true, stats: { size: (8 + 2 + 8 + 1) * 512, entries: 3, newestMtimeMs: 90 } });
  });

  it("handles directories wider than one batch of lstat calls", async () => {
    const mem = new MemoryFileSystem().mkdir("/t");
    for (let i = 0; i < 300; i++) mem.writeFile(`/t/f${i}`, { bytes: 512, mtimeMs: i });
    const r = await inspect(mem, "/t");
    expect(r).toEqual({ ok: true, stats: { size: (8 + 300) * 512, entries: 300, newestMtimeMs: 299 } });
  });

  it("refuses a name in the second batch of a wide directory", async () => {
    const mem = new MemoryFileSystem().mkdir("/t");
    for (let i = 0; i < 200; i++) mem.writeFile(`/t/f${i}`);
    mem.writeFile("/t/.env");
    expect(await inspect(mem, "/t")).toEqual({ ok: false, reason: "contains an environment file" });
  });

  it("reports an unreadable subdirectory with its error code", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/sub/f");
    const fs = failing(mem, { readdir: (p) => (p === "/t/sub" ? "EACCES" : null) });
    expect(await inspect(fs, "/t")).toEqual({ ok: false, reason: "cannot read directory (EACCES)" });
  });

  it("reports an entry that vanished between readdir and lstat", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/a").writeFile("/t/b");
    const fs = failing(mem, { lstat: (p) => (p === "/t/b" ? "ENOENT" : null) });
    expect(await inspect(fs, "/t")).toEqual({ ok: false, reason: "changed while scanning (ENOENT)" });
  });

  it("stops at the first refusal inside nested directories", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/a/b/c/.git/config").writeFile("/t/z");
    expect(await inspect(mem, "/t")).toEqual({ ok: false, reason: "contains a nested .git entry" });
  });

  it("enforces the depth limit", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/a/b/c/f");
    expect(await inspect(mem, "/t", { maxTreeDepth: 3 })).toMatchObject({ ok: true });
    expect(await inspect(mem, "/t", { maxTreeDepth: 2 })).toEqual({ ok: false, reason: "nested deeper than the depth limit" });
  });

  it("never follows a symlink: a link to a huge or foreign tree costs nothing", async () => {
    const mem = new MemoryFileSystem().writeFile("/outside/big", { bytes: 10_000_000 }).writeFile("/t/f", { bytes: 512 }).symlink("/t/l", "/outside");
    const r = await inspect(mem, "/t");
    expect(r).toEqual({ ok: true, stats: { size: (8 + 1) * 512, entries: 2, newestMtimeMs: 0 } });
  });

  it("applies the strict content-name policy only when asked", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/cert.pem");
    expect(await inspect(mem, "/t", { strict: false })).toMatchObject({ ok: true });
    expect(await inspect(mem, "/t", { strict: true })).toEqual({ ok: false, reason: "contains key material" });
  });

  it("enforces the entry limit and the device boundary", async () => {
    const mem = new MemoryFileSystem().writeFile("/t/a").writeFile("/t/b").mkdir("/t/mnt/x", { dev: 4n });
    expect(await inspect(mem, "/t", { maxEntries: 2 })).toEqual({ ok: false, reason: "more than 2 entries" });
    expect(await inspect(mem, "/t")).toEqual({ ok: false, reason: "crosses a file system boundary" });
  });
});

describe("newestSourceMtime", () => {
  const skip = new Set(["node_modules", ".git"]);

  it("finds the newest mtime of files and directories, skipping excluded names", async () => {
    const mem = new MemoryFileSystem()
      .writeFile("/p/a", { mtimeMs: 10 })
      .writeFile("/p/src/b", { mtimeMs: 70 })
      .writeFile("/p/node_modules/x", { mtimeMs: 999 })
      .writeFile("/p/.git/HEAD", { mtimeMs: 999 });
    expect(await newestSourceMtime(mem, "/p", 1n, skip, 100)).toEqual({ ok: true, newestMs: 70 });
  });

  it("does not count entries on another device or descend into them", async () => {
    const mem = new MemoryFileSystem().writeFile("/p/a", { mtimeMs: 10 }).mkdir("/p/mnt", { dev: 8n }).writeFile("/p/mnt/new", { mtimeMs: 500 }).setDev("/p/mnt", 8n);
    expect(await newestSourceMtime(mem, "/p", 1n, skip, 100)).toEqual({ ok: true, newestMs: 10 });
  });

  it("is zero for a directory with only excluded content", async () => {
    const mem = new MemoryFileSystem().mkdir("/p/node_modules");
    expect(await newestSourceMtime(mem, "/p", 1n, skip, 100)).toEqual({ ok: true, newestMs: 0 });
  });

  it("is bounded by the entry limit", async () => {
    const mem = new MemoryFileSystem().writeFile("/p/a").writeFile("/p/b").writeFile("/p/c");
    expect(await newestSourceMtime(mem, "/p", 1n, skip, 2)).toEqual({ ok: false, reason: "project has more than 2 source entries" });
    expect(await newestSourceMtime(mem, "/p", 1n, skip, 3)).toMatchObject({ ok: true });
  });

  it("explains unreadable directories and races", async () => {
    const mem = new MemoryFileSystem().writeFile("/p/a/f");
    expect(await newestSourceMtime(failing(mem, { readdir: (p) => (p === "/p/a" ? "EACCES" : null) }), "/p", 1n, skip, 10)).toEqual({ ok: false, reason: "cannot read project directory" });
    expect(await newestSourceMtime(failing(mem, { lstat: (p) => (p === "/p/a" ? "ENOENT" : null) }), "/p", 1n, skip, 10)).toEqual({ ok: false, reason: "project changed while scanning" });
  });
});
