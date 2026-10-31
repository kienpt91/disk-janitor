import { mkdirSync, rmSync, writeFileSync, lstatSync, readdirSync, utimesSync, lutimesSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ageTree, DAY, makeSandbox, type AgeOps } from "../support/helpers.js";

const real: AgeOps = { lstat: (p) => lstatSync(p), readdir: (p) => readdirSync(p), utimes: utimesSync, lutimes: lutimesSync };
const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), { code: "ENOENT" });

describe("ageTree tolerates entries that vanish while it walks (git background maintenance removes lock files)", () => {
  const NOW = Date.UTC(2026, 5, 1);

  it("an entry that disappears between readdir and lstat is skipped and the rest is still aged", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "repo");
    mkdirSync(join(dir, ".git", "objects"), { recursive: true });
    writeFileSync(join(dir, ".git", "objects", "maintenance.lock"), "");
    writeFileSync(join(dir, "keep.txt"), "x");
    // the lock file is listed, then removed before its lstat: exactly what happened in CI
    const ops: AgeOps = {
      ...real,
      readdir: (p) => {
        const names = readdirSync(p);
        if (p.endsWith("objects")) rmSync(join(p, "maintenance.lock"));
        return names;
      },
    };
    expect(() => ageTree(dir, 40, NOW, ops)).not.toThrow();
    expect(statSync(join(dir, "keep.txt")).mtimeMs).toBe(NOW - 40 * DAY);
    expect(statSync(join(dir, ".git", "objects")).mtimeMs).toBe(NOW - 40 * DAY);
  });

  it("an entry that disappears between lstat and utimes is skipped too", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "a"), "1");
    writeFileSync(join(dir, "b"), "2");
    const ops: AgeOps = {
      ...real,
      utimes: (p, a, m) => {
        if (p.endsWith("/a")) {
          rmSync(p);
          throw enoent(p);
        }
        utimesSync(p, a, m);
      },
    };
    expect(() => ageTree(dir, 10, NOW, ops)).not.toThrow();
    expect(statSync(join(dir, "b")).mtimeMs).toBe(NOW - 10 * DAY);
  });

  it("a symlink that disappears between lstat and lutimes is skipped", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "d");
    mkdirSync(dir);
    symlinkSync("/nonexistent-target", join(dir, "link"));
    const ops: AgeOps = {
      ...real,
      lutimes: (p) => {
        throw enoent(p);
      },
    };
    expect(() => ageTree(dir, 10, NOW, ops)).not.toThrow();
  });

  it("a whole subdirectory that vanishes before it is listed is skipped", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "d");
    mkdirSync(join(dir, "gone"), { recursive: true });
    writeFileSync(join(dir, "stay"), "1");
    const ops: AgeOps = {
      ...real,
      readdir: (p) => {
        if (p.endsWith("/gone")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return readdirSync(p);
      },
    };
    expect(() => ageTree(dir, 10, NOW, ops)).not.toThrow();
    expect(statSync(join(dir, "stay")).mtimeMs).toBe(NOW - 10 * DAY);
  });

  it("other errors are not swallowed (a permission problem is a real problem)", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "a"), "1");
    const ops: AgeOps = {
      ...real,
      utimes: (p) => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM", path: p });
      },
    };
    expect(() => ageTree(dir, 10, NOW, ops)).toThrow("EPERM");
  });

  it("a root that does not exist is still an error (only vanishing entries below it are tolerated)", () => {
    const sb = makeSandbox();
    expect(() => ageTree(join(sb.base, "missing"), 10, NOW, real)).toThrow(/ENOENT/);
  });

  it("ages a normal tree exactly as before", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "d");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f"), "1");
    ageTree(dir, 5, NOW);
    for (const p of [dir, join(dir, "sub"), join(dir, "sub", "f")]) expect(statSync(p).mtimeMs).toBe(NOW - 5 * DAY);
  });
});
