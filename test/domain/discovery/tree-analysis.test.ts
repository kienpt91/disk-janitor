import { describe, expect, it } from "vitest";
import {
  TreeAnalysis,
  changedWhileScanning,
  unreadableDirectory,
  type EntryFacts,
  type EntryKind,
  type TreeAnalysisOptions,
} from "../../../src/domain/discovery/tree-analysis.js";

const DEV = 7n;

function entry(kind: EntryKind, o: Partial<EntryFacts> = {}): EntryFacts {
  return { kind, dev: DEV, ino: 1n, nlink: 1n, blocks: 8n, mtimeMs: 0, ...o };
}

function analysis(o: Partial<Omit<TreeAnalysisOptions, "maxDepth">> & { maxDepth?: number } = {}, root = { blocks: 8n, mtimeMs: 100 }) {
  return new TreeAnalysis(root, { dev: DEV, maxEntries: 100, strict: false, ...o });
}

describe("TreeAnalysis accounting", () => {
  it("starts from the root's own blocks and mtime", () => {
    const r = analysis().finish();
    expect(r).toEqual({ ok: true, stats: { size: 4096, entries: 0, newestMtimeMs: 100 } });
  });

  it("sums allocated blocks of directories, files and symlinks", () => {
    const a = analysis();
    expect(a.admitNames(["d", "f", "l"])).toBeNull();
    expect(a.add(entry("directory", { blocks: 8n }), 0)).toBeNull();
    expect(a.add(entry("file", { blocks: 3n, ino: 2n }), 0)).toBeNull();
    expect(a.add(entry("symlink", { blocks: 0n, ino: 3n }), 0)).toBeNull();
    expect(a.finish()).toEqual({ ok: true, stats: { size: (8 + 8 + 3) * 512, entries: 3, newestMtimeMs: 100 } });
  });

  it("tracks the newest mtime over the root and every entry", () => {
    const a = analysis();
    a.admitNames(["a", "b"]);
    a.add(entry("file", { mtimeMs: 500, ino: 2n }), 0);
    a.add(entry("file", { mtimeMs: 300, ino: 3n }), 0);
    const r = a.finish();
    expect(r.ok && r.stats.newestMtimeMs).toBe(500);
  });

  it("counts a hard-linked file once when its whole link group is inside", () => {
    const a = analysis();
    a.admitNames(["a", "b"]);
    a.add(entry("file", { ino: 9n, nlink: 2n, blocks: 4n }), 0);
    a.add(entry("file", { ino: 9n, nlink: 2n, blocks: 4n }), 0);
    const r = a.finish();
    expect(r).toEqual({ ok: true, stats: { size: 4096 + 4 * 512, entries: 2, newestMtimeMs: 100 } });
  });

  it("refuses a hard-link group that extends outside the tree", () => {
    const a = analysis();
    a.admitNames(["a"]);
    a.add(entry("file", { ino: 9n, nlink: 3n }), 0);
    expect(a.finish()).toEqual({ ok: false, reason: "contains hard links shared with files outside the candidate" });
  });

  it("accounts independent hard-link groups separately", () => {
    const a = analysis();
    a.admitNames(["a", "b", "c", "d"]);
    for (const ino of [1n, 2n]) for (let i = 0; i < 2; i++) a.add(entry("file", { ino, nlink: 2n, blocks: 2n }), 0);
    const r = a.finish();
    expect(r.ok && r.stats.size).toBe(4096 + 2 * 2 * 512);
  });
});

describe("TreeAnalysis refusals", () => {
  it("refuses an entry on another device", () => {
    const a = analysis();
    a.admitNames(["x"]);
    expect(a.add(entry("file", { dev: 8n }), 0)).toBe("crosses a file system boundary");
  });

  it.each(["other"] as const)("refuses special files (%s)", (kind) => {
    const a = analysis();
    a.admitNames(["x"]);
    expect(a.add(entry(kind), 0)).toBe("contains a device, socket or fifo");
  });

  it("refuses names that are not valid UTF-8", () => {
    expect(analysis().admitNames(["ok", "bad\ufffdname"])).toBe("contains a name that is not valid UTF-8");
  });

  it.each([
    [".git", false, "contains a nested .git entry"],
    [".env", false, "contains an environment file"],
    ["id_rsa", false, "contains an ssh private key"],
    ["ibdata1", false, "looks like a database data directory"],
    ["server.pem", true, "contains key material"],
  ])("applies the content-name policy to %s (strict=%s)", (name, strict, reason) => {
    expect(analysis({ strict }).admitNames([name])).toBe(reason);
  });

  it("accepts key-material extensions when not strict", () => {
    expect(analysis({ strict: false }).admitNames(["test-cert.pem"])).toBeNull();
  });

  it("refuses more entries than the limit, counting across batches", () => {
    const a = analysis({ maxEntries: 3 });
    expect(a.admitNames(["a", "b"])).toBeNull();
    expect(a.admitNames(["c", "d"])).toBe("more than 3 entries");
  });

  it("allows exactly the limit", () => {
    expect(analysis({ maxEntries: 2 }).admitNames(["a", "b"])).toBeNull();
  });

  it("refuses directories nested deeper than the limit", () => {
    const a = analysis({ maxDepth: 2 });
    a.admitNames(["d"]);
    expect(a.add(entry("directory"), 0)).toBeNull();
    expect(a.add(entry("directory"), 1)).toBeNull();
    expect(a.add(entry("directory"), 2)).toBe("nested deeper than the depth limit");
  });

  it("does not limit the depth of files", () => {
    const a = analysis({ maxDepth: 0 });
    a.admitNames(["f"]);
    expect(a.add(entry("file"), 50)).toBeNull();
  });

  it("makes the first refusal final", () => {
    const a = analysis();
    a.admitNames(["x"]);
    a.add(entry("other"), 0);
    expect(a.admitNames([".git"])).toBe("contains a device, socket or fifo");
    expect(a.add(entry("file", { dev: 9n }), 0)).toBe("contains a device, socket or fifo");
    expect(a.refuse("later")).toBe("contains a device, socket or fifo");
    expect(a.refusedReason).toBe("contains a device, socket or fifo");
    expect(a.finish()).toEqual({ ok: false, reason: "contains a device, socket or fifo" });
  });

  it("records refusals found by the traversal itself", () => {
    const a = analysis();
    a.refuse(unreadableDirectory("EACCES"));
    expect(a.finish()).toEqual({ ok: false, reason: "cannot read directory (EACCES)" });
    expect(changedWhileScanning("ENOENT")).toBe("changed while scanning (ENOENT)");
    expect(changedWhileScanning(undefined)).toBe("changed while scanning (error)");
    expect(unreadableDirectory(undefined)).toBe("cannot read directory (error)");
  });
});

describe("TreeAnalysis construction", () => {
  it.each([-1, 1.5, Number.NaN])("rejects maxEntries %s", (n) => {
    expect(() => analysis({ maxEntries: n })).toThrow(RangeError);
  });
  it.each([-1, 2.5])("rejects maxDepth %s", (n) => {
    expect(() => analysis({ maxDepth: n })).toThrow(RangeError);
  });
  it("rejects negative root blocks", () => {
    expect(() => analysis({}, { blocks: -1n, mtimeMs: 0 })).toThrow(RangeError);
  });
});

// ---- property: the verdict does not depend on the order entries are discovered in ----

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

interface World {
  entries: EntryFacts[];
  expectedSize: number;
  expectedNewest: number;
}

/** Random entries with hard-link groups that are wholly inside; the expected totals are computed independently. */
function randomWorld(rand: () => number): World {
  const entries: EntryFacts[] = [];
  const root = { blocks: 8n, mtimeMs: 1000 };
  let size = 4096;
  let newest = root.mtimeMs;
  const note = (e: EntryFacts) => {
    newest = Math.max(newest, e.mtimeMs);
    entries.push(e);
  };
  const count = Math.floor(rand() * 40);
  for (let i = 0; i < count; i++) {
    const r = rand();
    const mtimeMs = Math.floor(rand() * 100_000);
    const blocks = BigInt(Math.floor(rand() * 64));
    if (r < 0.2) {
      note(entry("directory", { blocks, mtimeMs, ino: BigInt(1000 + i) }));
      size += Number(blocks) * 512;
    } else if (r < 0.4) {
      const members = 2 + Math.floor(rand() * 3);
      const ino = BigInt(5000 + i);
      size += Number(blocks) * 512;
      for (let m = 0; m < members; m++) note(entry("file", { ino, nlink: BigInt(members), blocks, mtimeMs: Math.floor(rand() * 100_000) }));
    } else {
      note(entry(r < 0.9 ? "file" : "symlink", { blocks, mtimeMs, ino: BigInt(9000 + i) }));
      size += Number(blocks) * 512;
    }
  }
  return { entries, expectedSize: size, expectedNewest: newest };
}

describe("TreeAnalysis property: totals are independent of discovery order", () => {
  it("size, entries and newest mtime are exact for 300 seeded random trees in any order", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const world = randomWorld(rand);
      for (const order of [world.entries, shuffle(world.entries, rand), [...world.entries].reverse()]) {
        const a = analysis({ maxEntries: 1000 }, { blocks: 8n, mtimeMs: 1000 });
        expect(a.admitNames(order.map((_, i) => `n${i}`))).toBeNull();
        for (const e of order) expect(a.add(e, 0)).toBeNull();
        expect(a.finish()).toEqual({ ok: true, stats: { size: world.expectedSize, entries: order.length, newestMtimeMs: world.expectedNewest } });
      }
    }
  });

  it("a hard-link group missing one member is refused in every order", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = rng(seed);
      const world = randomWorld(rand);
      const withOutsider = [...world.entries, entry("file", { ino: 424242n, nlink: 2n })];
      const a = analysis({ maxEntries: 1000 });
      a.admitNames(withOutsider.map((_, i) => `n${i}`));
      for (const e of shuffle(withOutsider, rand)) a.add(e, 0);
      expect(a.finish()).toEqual({ ok: false, reason: "contains hard links shared with files outside the candidate" });
    }
  });
});
