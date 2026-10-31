import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, isCanonicalAbsolute } from "../src/domain/shared/paths.js";
import { MAX_SKIPPED } from "../src/detectors/common.js";
import { ageTree, makeConfig, makeMixedTree, makeProject, makeSandbox, testDeps, treeHash, writeBytes, writeText } from "./helpers.js";
import { candidatePaths, recordingFs, scanFor } from "./helpers-detectors.js";
import { nodeFs } from "../src/infrastructure/fs/node-fs.js";
import { scan } from "../src/scan.js";

describe("scan: read-only", () => {
  it("does not modify anything in the sandbox and creates no state directory", async () => {
    const sb = makeSandbox();
    makeMixedTree(sb);
    const before = treeHash(sb.base);
    const { result } = await scanFor(sb);
    expect(result.fs.length).toBeGreaterThan(0);
    expect(treeHash(sb.base)).toBe(before);
    expect(existsSync(sb.state)).toBe(false);
  });

  it("never calls rename", async () => {
    const sb = makeSandbox();
    makeMixedTree(sb);
    let renames = 0;
    const fs = { ...nodeFs, rename: async () => void renames++ };
    await scanFor(sb, {}, testDeps({ fs }));
    expect(renames).toBe(0);
  });

  it("only ever runs git, lsof and docker commands, all read-only", async () => {
    const sb = makeSandbox();
    makeMixedTree(sb);
    const deps = testDeps({ lsof: [] });
    await scanFor(sb, {}, deps);
    const commands = new Set(deps.calls.map((c) => c.command));
    expect([...commands].sort()).toEqual(["docker", "git", "lsof"]);
    const gitVerbs = new Set(deps.calls.filter((c) => c.command === "git").map((c) => c.args.filter((a) => !a.startsWith("-") && !a.startsWith("core."))[0]));
    for (const v of gitVerbs) expect(["rev-parse", "status", "check-ignore", "ls-files", "worktree"]).toContain(v);
  });

  it("the mixed tree yields the expected candidates and keeps unsafe projects out", async () => {
    const sb = makeSandbox();
    const t = makeMixedTree(sb);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual(
      [join(t.webapp, "node_modules"), join(t.webapp, "dist"), join(t.api, "node_modules"), join(t.api, "target")].sort(),
    );
    expect(result.skipped.map((s) => s.path)).toContain(join(t.wip, "node_modules"));
    expect(result.skipped.map((s) => s.path)).toContain(join(t.fresh, "node_modules"));
    expect(result.warnings).toEqual([]);
  });

  it("counts visited directories", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "a"));
    const { result } = await scanFor(sb);
    // root, a, a/src (node_modules and .git are never descended into)
    expect(result.dirsVisited).toBe(3);
  });
});

describe("scan: ordering, dedupe and limits", () => {
  it("sorts candidates by size, largest first", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "small"), { nodeModules: 4096 });
    makeProject(join(sb.projects, "large"), { nodeModules: 400_000 });
    makeProject(join(sb.projects, "medium"), { nodeModules: 40_000 });
    const { result } = await scanFor(sb);
    expect(result.fs.map((c) => c.path.split("/").at(-2))).toEqual(["large", "medium", "small"]);
    const sizes = result.fs.map((c) => c.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("breaks size ties by path", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "b"));
    makeProject(join(sb.projects, "a"));
    makeProject(join(sb.projects, "c"));
    const { result } = await scanFor(sb);
    expect(result.fs.map((c) => c.path.split("/").at(-2))).toEqual(["a", "b", "c"]);
  });

  it("drops a candidate that lies inside another and records why", async () => {
    const sb = makeSandbox();
    // a project that lives inside a package-manager cache, with the root pointing at the cache's parent
    const cache = join(sb.home, ".cache", "yarn");
    const inner = makeProject(join(cache, "proj"));
    writeBytes(join(cache, "blob.bin"), 8192);
    ageTree(cache, 60);
    const { result } = await scanFor(sb, { roots: [join(sb.home, ".cache")], packageCaches: true });
    expect(result.fs.map((c) => [c.detector, c.path])).toEqual([["package-cache", cache]]);
    expect(result.skipped).toContainEqual({ detector: "node-modules", path: join(inner, "node_modules"), reason: "inside another candidate" });
  });

  it("no candidate is ever inside another candidate", async () => {
    const sb = makeSandbox();
    makeMixedTree(sb);
    const cache = join(sb.home, ".cache", "yarn");
    makeProject(join(cache, "proj"));
    ageTree(cache, 60);
    const { result } = await scanFor(sb, { roots: [sb.projects, join(sb.home, ".cache")], packageCaches: true });
    const paths = result.fs.map((c) => c.path);
    expect(paths.length).toBeGreaterThan(3);
    for (const a of paths) for (const b of paths) if (a !== b) expect(isInside(a, b)).toBe(false);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("maxCandidates keeps the largest and adds a warning", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "p1"), { nodeModules: 4096 });
    makeProject(join(sb.projects, "p2"), { nodeModules: 90_000 });
    makeProject(join(sb.projects, "p3"), { nodeModules: 200_000 });
    makeProject(join(sb.projects, "p4"), { nodeModules: 20_000 });
    const { result } = await scanFor(sb, { maxCandidates: 2 });
    expect(result.fs.map((c) => c.path.split("/").at(-2))).toEqual(["p3", "p2"]);
    expect(result.warnings).toEqual(["more than 2 candidates found; only the largest are listed"]);
  });

  it("no warning when the number of candidates equals maxCandidates", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "p1"));
    makeProject(join(sb.projects, "p2"));
    const { result } = await scanFor(sb, { maxCandidates: 2 });
    expect(result.fs).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("caps the skipped list but keeps counting", async () => {
    const sb = makeSandbox();
    const total = MAX_SKIPPED + 100;
    for (let i = 0; i < total; i++) mkdirSync(join(sb.projects, `p${i}`, "node_modules"), { recursive: true });
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(result.skipped).toHaveLength(MAX_SKIPPED);
    expect(result.skippedCount).toBe(total);
  });

  it("a root that vanished after configuration only produces a warning", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "a"));
    const deps = testDeps();
    const config = await makeConfig(sb, {}, deps);
    rmSync(sb.projects, { recursive: true });
    const result = await scan(config, deps);
    expect(result.fs).toEqual([]);
    expect(result.warnings).toEqual([`root is not a real directory any more: ${sb.projects}`]);
  });

  it("scans every configured root", async () => {
    const sb = makeSandbox();
    const second = join(sb.home, "work");
    const a = makeProject(join(sb.projects, "a"));
    const b = makeProject(join(second, "b"));
    const { result } = await scanFor(sb, { roots: [sb.projects, second] });
    expect(candidatePaths(result)).toEqual([join(a, "node_modules"), join(b, "node_modules")].sort());
  });
});

describe("scan: detector selection", () => {
  async function mixed() {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    makeProject(dir);
    writeBytes(join(dir, "dist", "a.js"), 4096);
    ageTree(dir, 60);
    return { sb, dir };
  }

  it("runs every default detector when none is given", async () => {
    const { sb, dir } = await mixed();
    const { result, config } = await scanFor(sb);
    expect(config.detectors).toEqual(["node-modules", "build-output", "docker", "git-worktrees"]);
    expect(candidatePaths(result)).toEqual([join(dir, "dist"), join(dir, "node_modules")]);
  });

  it("detectors: [node-modules] finds only node_modules", async () => {
    const { sb, dir } = await mixed();
    const deps = testDeps();
    const { result } = await scanFor(sb, { detectors: ["node-modules"] }, deps);
    expect(candidatePaths(result)).toEqual([join(dir, "node_modules")]);
    expect(deps.calls.some((c) => c.command === "docker")).toBe(false);
  });

  it("detectors: [build-output] finds only build output", async () => {
    const { sb, dir } = await mixed();
    const { result } = await scanFor(sb, { detectors: ["build-output"] });
    expect(candidatePaths(result)).toEqual([join(dir, "dist")]);
  });

  it("detectors: [git-worktrees] offers no filesystem candidates", async () => {
    const { sb } = await mixed();
    const { result } = await scanFor(sb, { detectors: ["git-worktrees"] });
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("package-cache runs only when requested", async () => {
    const sb = makeSandbox();
    writeBytes(join(sb.home, ".npm", "_cacache", "x"), 4096);
    ageTree(join(sb.home, ".npm"), 30);
    expect((await scanFor(sb)).result.fs).toEqual([]);
    expect((await scanFor(sb, { detectors: ["package-cache"] })).result.fs).toHaveLength(1);
  });
});

describe("scan: canonical paths and symlinks", () => {
  it("returns realpath-canonical candidate paths even when the root is given through a symlink", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    const link = join(sb.base, "via-link");
    symlinkSync(sb.projects, link);
    const { result, config } = await scanFor(sb, { roots: [link] });
    expect(config.roots).toEqual([sb.projects]);
    expect(candidatePaths(result)).toEqual([join(proj, "node_modules")]);
    for (const c of result.fs) {
      expect(isCanonicalAbsolute(c.path)).toBe(true);
      expect(realpathSync(c.path)).toBe(c.path);
      expect(c.path.startsWith(link)).toBe(false);
    }
  });

  it("does not descend into a symlinked directory inside the root", async () => {
    const sb = makeSandbox();
    const outside = join(sb.base, "outside");
    makeProject(join(outside, "proj"));
    symlinkSync(outside, join(sb.projects, "linked"));
    const seen: string[] = [];
    const { result } = await scanFor(sb, {}, testDeps({ fs: recordingFs(nodeFs, seen) }));
    expect(result.fs).toEqual([]);
    expect(seen.some((p) => p.startsWith(outside + "/"))).toBe(false);
  });

  it("every candidate path is absolute and has no dot segments", async () => {
    const sb = makeSandbox();
    makeMixedTree(sb);
    const { result } = await scanFor(sb);
    for (const c of result.fs) {
      expect(isCanonicalAbsolute(c.path)).toBe(true);
      expect(c.dev).toMatch(/^[0-9]+$/);
      expect(c.ino).toMatch(/^[0-9]+$/);
    }
  });

  it("a nested symlink to a directory is not offered as a candidate", async () => {
    const sb = makeSandbox();
    const real = join(sb.base, "real-dist");
    writeBytes(join(real, "a.js"), 4096);
    const dir = join(sb.projects, "app");
    writeText(join(dir, "package.json"), "{}\n");
    symlinkSync(real, join(dir, "dist"));
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
  });
});

describe("scan: hostile names", () => {
  it("returns names with newlines and escape sequences verbatim without crashing", async () => {
    const sb = makeSandbox();
    const newline = makeProject(join(sb.projects, "line\nbreak"));
    const esc = makeProject(join(sb.projects, "\u001b[31mred\u001b[0m"));
    const bell = makeProject(join(sb.projects, "bell\u0007name"));
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(bell, "node_modules"), join(esc, "node_modules"), join(newline, "node_modules")].sort());
    expect(result.fs.some((c) => c.path.includes("\n"))).toBe(true);
    expect(result.fs.some((c) => c.path.includes("\u001b[31m"))).toBe(true);
  });

  it("handles odd but valid names: spaces, dashes, quotes, shell metacharacters, unicode", async () => {
    const sb = makeSandbox();
    const names = [" leading space", "-rf", "--help", "a'b\"c", "$(touch pwned)", "x;y|z&w", "%s%n", "..hidden..", "日本語", "trailing "];
    const expected = names.map((n) => join(makeProject(join(sb.projects, n)), "node_modules"));
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual(expected.sort());
    expect(existsSync(join(sb.projects, "pwned"))).toBe(false);
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
  });

  it("never walks a directory whose name is not valid UTF-8 (replacement character)", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "bad\ufffdname"));
    const ok = makeProject(join(sb.projects, "good"));
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(ok, "node_modules")]);
  });

  it("rejects a candidate that contains a file with an unrepresentable name", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, "node_modules", "dep", "bad\ufffdfile.js"), "x\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([
      { detector: "node-modules", path: join(proj, "node_modules"), reason: "contains a name that is not valid UTF-8" },
    ]);
  });

  it("hostile file names inside node_modules are fine and do not appear in candidate paths", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, "node_modules", "dep", "evil\nname.js"), "x\n");
    writeText(join(proj, "node_modules", "dep", "\u001b[2Jclear.js"), "x\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, "node_modules")]);
    expect(result.fs[0]!.entries).toBe(4);
  });
});
