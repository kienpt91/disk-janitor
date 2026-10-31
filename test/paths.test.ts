import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertCanonicalAbsolute, findSymlinkInChain, isCanonicalAbsolute, isInside, prefixes } from "../src/paths.js";
import { makeSandbox, testDeps, writeText } from "./helpers.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("isInside", () => {
  it("is true for equal paths and descendants", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("is false for prefix confusion and siblings", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b-x/c")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
    expect(isInside("/a/b", "/x/a/b")).toBe(false);
  });

  it("treats '/' as containing everything", () => {
    expect(isInside("/", "/")).toBe(true);
    expect(isInside("/", "/etc")).toBe(true);
    expect(isInside("/etc", "/")).toBe(false);
  });

  it("property: agrees with a path.relative reference for 300 random normalized pairs", () => {
    const rnd = mulberry32(1234);
    const names = ["a", "b", "ab", "bc", "a.b", "x y", "-"];
    const mk = () => {
      const n = Math.floor(rnd() * 4);
      let p = "";
      for (let i = 0; i < n; i++) p += sep + names[Math.floor(rnd() * names.length)];
      return p === "" ? sep : p;
    };
    for (let i = 0; i < 300; i++) {
      const parent = mk();
      // bias towards related pairs
      const child = rnd() < 0.5 ? parent + (rnd() < 0.5 ? "" : sep + names[Math.floor(rnd() * names.length)]) + (rnd() < 0.3 ? names[0] : "") : mk();
      const normalizedChild = child.replace(/\/+/g, "/");
      const rel = relative(parent, normalizedChild);
      const expected = rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
      expect(isInside(parent, normalizedChild), `${parent} ${normalizedChild}`).toBe(expected);
    }
  });
});

describe("isCanonicalAbsolute", () => {
  it("accepts canonical absolute paths", () => {
    expect(isCanonicalAbsolute("/")).toBe(true);
    expect(isCanonicalAbsolute("/a/b/c")).toBe(true);
    expect(isCanonicalAbsolute("/a/b.c/d e")).toBe(true);
    expect(isCanonicalAbsolute("/a/..b")).toBe(true);
  });

  it("rejects relative paths and the empty string", () => {
    expect(isCanonicalAbsolute("a/b")).toBe(false);
    expect(isCanonicalAbsolute("./a")).toBe(false);
    expect(isCanonicalAbsolute("")).toBe(false);
  });

  it("rejects '..', '.', double and trailing slashes", () => {
    expect(isCanonicalAbsolute("/a/../b")).toBe(false);
    expect(isCanonicalAbsolute("/a/..")).toBe(false);
    expect(isCanonicalAbsolute("/a/./b")).toBe(false);
    expect(isCanonicalAbsolute("/a//b")).toBe(false);
    expect(isCanonicalAbsolute("/a/b/")).toBe(false);
  });

  it("rejects NUL bytes and over-long paths", () => {
    expect(isCanonicalAbsolute("/a/b\0c")).toBe(false);
    expect(isCanonicalAbsolute("/" + "a".repeat(4096))).toBe(false);
    expect(isCanonicalAbsolute("/" + "a".repeat(4095))).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isCanonicalAbsolute(undefined as unknown as string)).toBe(false);
    expect(isCanonicalAbsolute(42 as unknown as string)).toBe(false);
  });

  it("assertCanonicalAbsolute throws with the label", () => {
    expect(() => assertCanonicalAbsolute("rel", "plan path")).toThrow("plan path is not a canonical absolute path");
    expect(() => assertCanonicalAbsolute("/ok")).not.toThrow();
  });
});

describe("prefixes", () => {
  it("lists every prefix from the first component to the full path", () => {
    expect(prefixes("/a/b/c")).toEqual(["/a", "/a/b", "/a/b/c"]);
    expect(prefixes("/a")).toEqual(["/a"]);
  });

  it("returns nothing for the root", () => {
    expect(prefixes("/")).toEqual([]);
  });
});

describe("findSymlinkInChain", () => {
  const fs = testDeps().fs;

  it("returns null for a plain directory chain", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.projects, "a", "b"), { recursive: true });
    expect(await findSymlinkInChain(fs, join(sb.projects, "a", "b"), true)).toBeNull();
    expect(await findSymlinkInChain(fs, join(sb.projects, "a", "b"), false)).toBeNull();
  });

  it("finds a symlink at a middle component", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.base, "real", "deep"), { recursive: true });
    symlinkSync(join(sb.base, "real"), join(sb.projects, "link"));
    const target = join(sb.projects, "link", "deep");
    expect(await findSymlinkInChain(fs, target, false)).toBe(join(sb.projects, "link"));
    expect(await findSymlinkInChain(fs, target, true)).toBe(join(sb.projects, "link"));
  });

  it("final component symlink is reported only with includeSelf", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.base, "real"));
    const link = join(sb.projects, "last");
    symlinkSync(join(sb.base, "real"), link);
    expect(await findSymlinkInChain(fs, link, false)).toBeNull();
    expect(await findSymlinkInChain(fs, link, true)).toBe(link);
  });

  it("reports a file used as a directory component", async () => {
    const sb = makeSandbox();
    const file = join(sb.projects, "file");
    writeText(file, "x");
    expect(await findSymlinkInChain(fs, join(file, "child"), false)).toBe(file);
  });

  it("a regular file as the final component is not reported", async () => {
    const sb = makeSandbox();
    const file = join(sb.projects, "file");
    writeText(file, "x");
    expect(await findSymlinkInChain(fs, file, true)).toBeNull();
  });

  it("reports the first offender when several exist", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.base, "r1", "x"), { recursive: true });
    symlinkSync(join(sb.base, "r1"), join(sb.projects, "one"));
    expect(await findSymlinkInChain(fs, join(sb.projects, "one", "x"), true)).toBe(join(sb.projects, "one"));
  });

  it("propagates ENOENT for missing components", async () => {
    const sb = makeSandbox();
    await expect(findSymlinkInChain(fs, join(sb.projects, "missing", "x"), false)).rejects.toThrow(/ENOENT/);
  });
});
