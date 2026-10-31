import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSystem } from "../../src/application/ports/common.js";
import { nodeFs } from "../../src/infrastructure/fs/node-fs.js";
import { makeSandbox } from "../support/helpers.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";

/** Builds fixtures in whatever backs the FileSystem under test. */
interface World {
  fs: FileSystem;
  root: string;
  dir(path: string): void;
  file(path: string, bytes?: number): void;
  symlink(path: string, target: string): void;
  hardlink(from: string, to: string): void;
}

function memoryWorld(): World {
  const mem = new MemoryFileSystem().mkdir("/work");
  return {
    fs: mem,
    root: "/work",
    dir: (p) => void mem.mkdir(p),
    file: (p, bytes = 1) => void mem.writeFile(p, { bytes }),
    symlink: (p, t) => void mem.symlink(p, t),
    hardlink: (a, b) => void mem.link(a, b),
  };
}

function realWorld(): World {
  const sb = makeSandbox();
  return {
    fs: nodeFs,
    root: sb.base,
    dir: (p) => void mkdirSync(p, { recursive: true }),
    file: (p, bytes = 1) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, Buffer.alloc(bytes, 0x61));
    },
    symlink: (p, t) => {
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(t, p);
    },
    hardlink: (a, b) => {
      mkdirSync(dirname(b), { recursive: true });
      linkSync(a, b);
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe.each([
  ["MemoryFileSystem", memoryWorld],
  ["nodeFs", realWorld],
])("FileSystem port contract: %s", (_name, make) => {
  describe("lstat", () => {
    it("describes regular files with bigint identity and block counts", async () => {
      const w = make();
      w.file(join(w.root, "a.txt"), 3000);
      const st = await w.fs.lstat(join(w.root, "a.txt"));
      expect(st.isFile()).toBe(true);
      expect(st.isDirectory()).toBe(false);
      expect(st.isSymbolicLink()).toBe(false);
      expect(typeof st.dev).toBe("bigint");
      expect(typeof st.ino).toBe("bigint");
      expect(typeof st.mtimeMs).toBe("bigint");
      expect(st.nlink).toBe(1n);
      expect(st.blocks * 512n).toBeGreaterThanOrEqual(3000n);
    });

    it("describes directories", async () => {
      const w = make();
      w.dir(join(w.root, "d"));
      const st = await w.fs.lstat(join(w.root, "d"));
      expect(st.isDirectory()).toBe(true);
      expect(st.isFile()).toBe(false);
      expect(st.isSymbolicLink()).toBe(false);
    });

    it("never follows a symlink in the final component", async () => {
      const w = make();
      w.dir(join(w.root, "real"));
      w.symlink(join(w.root, "link"), join(w.root, "real"));
      const st = await w.fs.lstat(join(w.root, "link"));
      expect(st.isSymbolicLink()).toBe(true);
      expect(st.isDirectory()).toBe(false);
    });

    it("describes a dangling symlink instead of failing", async () => {
      const w = make();
      w.symlink(join(w.root, "dangling"), join(w.root, "nowhere"));
      expect((await w.fs.lstat(join(w.root, "dangling"))).isSymbolicLink()).toBe(true);
    });

    it("resolves symlinks in parent components (only the last is never followed)", async () => {
      const w = make();
      w.file(join(w.root, "real", "f"));
      w.symlink(join(w.root, "via"), join(w.root, "real"));
      const st = await w.fs.lstat(join(w.root, "via", "f"));
      expect(st.isFile()).toBe(true);
    });

    it("reports hard links as one inode with a link count", async () => {
      const w = make();
      w.file(join(w.root, "one"), 10);
      w.hardlink(join(w.root, "one"), join(w.root, "sub", "two"));
      const a = await w.fs.lstat(join(w.root, "one"));
      const b = await w.fs.lstat(join(w.root, "sub", "two"));
      expect(a.ino).toBe(b.ino);
      expect(a.nlink).toBe(2n);
      expect(b.nlink).toBe(2n);
    });

    it("distinguishes inodes of different files and keeps the device within a tree", async () => {
      const w = make();
      w.file(join(w.root, "x"));
      w.file(join(w.root, "y"));
      const x = await w.fs.lstat(join(w.root, "x"));
      const y = await w.fs.lstat(join(w.root, "y"));
      expect(x.ino).not.toBe(y.ino);
      expect(x.dev).toBe(y.dev);
    });

    it("fails with ENOENT for a missing path", async () => {
      const w = make();
      expect(await codeOf(w.fs.lstat(join(w.root, "missing")))).toBe("ENOENT");
      expect(await codeOf(w.fs.lstat(join(w.root, "missing", "deeper")))).toBe("ENOENT");
    });

    it("fails with ENOTDIR when a parent component is a file", async () => {
      const w = make();
      w.file(join(w.root, "f"));
      expect(await codeOf(w.fs.lstat(join(w.root, "f", "child")))).toBe("ENOTDIR");
    });
  });

  describe("readdir", () => {
    it("lists names, dotfiles included, without . and ..", async () => {
      const w = make();
      w.file(join(w.root, "d", "a"));
      w.file(join(w.root, "d", ".hidden"));
      w.dir(join(w.root, "d", "sub"));
      expect((await w.fs.readdir(join(w.root, "d"))).sort()).toEqual([".hidden", "a", "sub"]);
    });

    it("returns plain names, not paths, and lists a symlink as an entry", async () => {
      const w = make();
      w.symlink(join(w.root, "d", "l"), "/nonexistent");
      expect(await w.fs.readdir(join(w.root, "d"))).toEqual(["l"]);
    });

    it("is empty for an empty directory", async () => {
      const w = make();
      w.dir(join(w.root, "empty"));
      expect(await w.fs.readdir(join(w.root, "empty"))).toEqual([]);
    });

    it("keeps names with spaces, unicode and newlines intact", async () => {
      const w = make();
      const names = ["with space", "ünï", "line\nbreak"];
      for (const n of names) w.file(join(w.root, "d", n));
      expect((await w.fs.readdir(join(w.root, "d"))).sort()).toEqual([...names].sort());
    });

    it("fails with ENOENT for a missing directory and ENOTDIR for a file", async () => {
      const w = make();
      w.file(join(w.root, "f"));
      expect(await codeOf(w.fs.readdir(join(w.root, "missing")))).toBe("ENOENT");
      expect(await codeOf(w.fs.readdir(join(w.root, "f")))).toBe("ENOTDIR");
    });
  });

  describe("realpath", () => {
    it("returns an already canonical path unchanged", async () => {
      const w = make();
      w.dir(join(w.root, "a", "b"));
      expect(await w.fs.realpath(join(w.root, "a", "b"))).toBe(join(w.root, "a", "b"));
    });

    it("resolves symlinks, absolute and relative, anywhere in the chain", async () => {
      const w = make();
      w.file(join(w.root, "real", "deep", "f"));
      w.symlink(join(w.root, "abs"), join(w.root, "real"));
      w.symlink(join(w.root, "real", "rel"), "deep");
      expect(await w.fs.realpath(join(w.root, "abs", "deep"))).toBe(join(w.root, "real", "deep"));
      expect(await w.fs.realpath(join(w.root, "abs", "rel", "f"))).toBe(join(w.root, "real", "deep", "f"));
    });

    it("resolves a final-component symlink (unlike lstat)", async () => {
      const w = make();
      w.dir(join(w.root, "target"));
      w.symlink(join(w.root, "l1"), join(w.root, "target"));
      w.symlink(join(w.root, "l2"), join(w.root, "l1"));
      expect(await w.fs.realpath(join(w.root, "l2"))).toBe(join(w.root, "target"));
    });

    it("normalizes dot segments", async () => {
      const w = make();
      w.dir(join(w.root, "a", "b"));
      expect(await w.fs.realpath(`${w.root}/a/./b/../b`)).toBe(join(w.root, "a", "b"));
    });

    it("fails with ENOENT for a missing path and for a dangling symlink", async () => {
      const w = make();
      w.symlink(join(w.root, "dangling"), join(w.root, "nowhere"));
      expect(await codeOf(w.fs.realpath(join(w.root, "missing")))).toBe("ENOENT");
      expect(await codeOf(w.fs.realpath(join(w.root, "dangling")))).toBe("ENOENT");
    });

    it("fails with ELOOP for a symlink cycle", async () => {
      const w = make();
      w.symlink(join(w.root, "a"), join(w.root, "b"));
      w.symlink(join(w.root, "b"), join(w.root, "a"));
      expect(await codeOf(w.fs.realpath(join(w.root, "a")))).toBe("ELOOP");
    });
  });

  describe("rename", () => {
    it("moves a file and removes the source", async () => {
      const w = make();
      w.file(join(w.root, "src", "f"), 100);
      w.dir(join(w.root, "dst"));
      const before = await w.fs.lstat(join(w.root, "src", "f"));
      await w.fs.rename(join(w.root, "src", "f"), join(w.root, "dst", "g"));
      expect(await codeOf(w.fs.lstat(join(w.root, "src", "f")))).toBe("ENOENT");
      const after = await w.fs.lstat(join(w.root, "dst", "g"));
      expect(after.isFile()).toBe(true);
      expect(after.ino).toBe(before.ino);
    });

    it("moves a whole directory tree in one step, keeping its contents", async () => {
      const w = make();
      w.file(join(w.root, "tree", "a", "f"));
      w.file(join(w.root, "tree", "g"));
      w.dir(join(w.root, "quarantine"));
      await w.fs.rename(join(w.root, "tree"), join(w.root, "quarantine", "tree"));
      expect(await codeOf(w.fs.lstat(join(w.root, "tree")))).toBe("ENOENT");
      expect((await w.fs.readdir(join(w.root, "quarantine", "tree"))).sort()).toEqual(["a", "g"]);
      expect((await w.fs.lstat(join(w.root, "quarantine", "tree", "a", "f"))).isFile()).toBe(true);
    });

    it("renames a directory onto an empty directory", async () => {
      const w = make();
      w.file(join(w.root, "from", "f"));
      w.dir(join(w.root, "to"));
      await w.fs.rename(join(w.root, "from"), join(w.root, "to"));
      expect(await w.fs.readdir(join(w.root, "to"))).toEqual(["f"]);
    });

    it("refuses to replace a non-empty directory and leaves both untouched", async () => {
      const w = make();
      w.file(join(w.root, "from", "f"));
      w.file(join(w.root, "to", "existing"));
      const code = await codeOf(w.fs.rename(join(w.root, "from"), join(w.root, "to")));
      expect(["ENOTEMPTY", "EEXIST"]).toContain(code);
      expect(await w.fs.readdir(join(w.root, "from"))).toEqual(["f"]);
      expect(await w.fs.readdir(join(w.root, "to"))).toEqual(["existing"]);
    });

    it("moves a symlink itself, not what it points to", async () => {
      const w = make();
      w.file(join(w.root, "target", "f"));
      w.symlink(join(w.root, "l"), join(w.root, "target"));
      await w.fs.rename(join(w.root, "l"), join(w.root, "moved"));
      expect((await w.fs.lstat(join(w.root, "moved"))).isSymbolicLink()).toBe(true);
      expect((await w.fs.lstat(join(w.root, "target", "f"))).isFile()).toBe(true);
      expect(await codeOf(w.fs.lstat(join(w.root, "l")))).toBe("ENOENT");
    });

    it("fails with ENOENT for a missing source or a missing destination parent", async () => {
      const w = make();
      w.file(join(w.root, "f"));
      expect(await codeOf(w.fs.rename(join(w.root, "missing"), join(w.root, "x")))).toBe("ENOENT");
      expect(await codeOf(w.fs.rename(join(w.root, "f"), join(w.root, "no-such-dir", "x")))).toBe("ENOENT");
      expect((await w.fs.lstat(join(w.root, "f"))).isFile()).toBe(true);
    });
  });
});

describe("MemoryFileSystem device boundaries", () => {
  it("rename across devices fails with EXDEV like the kernel does, and moves nothing", async () => {
    const mem = new MemoryFileSystem().mkdir("/work").mkdir("/mnt/other", { dev: 9n }).writeFile("/work/f");
    expect(await codeOf(mem.rename("/work/f", "/mnt/other/f"))).toBe("EXDEV");
    expect(mem.exists("/work/f")).toBe(true);
    expect(mem.renames).toEqual([]);
  });

  it("entries below a mount carry its device number", async () => {
    const mem = new MemoryFileSystem().mkdir("/work").mkdir("/work/mnt", { dev: 5n }).writeFile("/work/mnt/f");
    expect((await mem.lstat("/work/mnt/f")).dev).toBe(5n);
    expect((await mem.lstat("/work")).dev).not.toBe(5n);
  });
});
