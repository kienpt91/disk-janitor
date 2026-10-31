import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync, readdirSync, utimesSync, lutimesSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ageTree, DAY, GIT_ENV, git, gitInit, makeSandbox, type AgeOps } from "../support/helpers.js";

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

describe("test repositories never run git background maintenance", () => {
  const maintenanceChildren = (trace: string): string[] =>
    trace
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
      .filter((e) => e.event === "child_start" && e.argv?.some((a) => a === "maintenance" || a === "gc"))
      .map((e) => (e.argv as string[]).join(" "));

  function commitWithTrace(extraEnv: Record<string, string | undefined>, unsetKeys: string[] = []): string[] {
    const sb = makeSandbox();
    const dir = join(sb.base, "repo");
    mkdirSync(dir);
    writeFileSync(join(dir, "f.txt"), "x");
    const trace = join(sb.base, "trace.json");
    const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV, ...extraEnv, GIT_TRACE2_EVENT: trace };
    for (const k of unsetKeys) delete env[k];
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
    execFileSync("git", ["add", "-A"], { cwd: dir, env });
    execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: dir, env });
    return maintenanceChildren(readFileSync(trace, "utf8"));
  }

  it("control: without the test configuration a commit starts `git maintenance run --auto`", () => {
    const children = commitWithTrace({}, ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]);
    expect(children.some((c) => c.includes("maintenance"))).toBe(true);
  });

  it("with the shared test environment a commit starts neither maintenance nor gc", () => {
    expect(commitWithTrace({})).toEqual([]);
  });

  it("the helper that all git-backed tests use (gitInit) carries the same configuration", () => {
    const sb = makeSandbox();
    const dir = join(sb.base, "repo");
    mkdirSync(dir);
    gitInit(dir, "node_modules\n");
    expect(git(dir, "config", "--get", "gc.auto").trim()).toBe("0");
    expect(git(dir, "config", "--get", "maintenance.auto").trim()).toBe("false");
  });
});
