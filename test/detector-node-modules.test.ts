import { linkSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFs, type FsApi } from "../src/fsapi.js";
import { RootsError } from "../src/roots.js";
import { ageTree, DAY, git, makeConfig, makeProject, makeSandbox, testDeps, treeHash, writeBytes, writeText } from "./helpers.js";
import { candidatePaths, recordingFs, scanFor, skippedFor, touch } from "./helpers-detectors.js";

const NM = "node_modules";

describe("node-modules detector: positives", () => {
  const kinds: Array<[string, string]> = [
    ["package-lock.json", "npm ci"],
    ["npm-shrinkwrap.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
  ];

  it.each(kinds)("offers node_modules next to %s with the matching regenerate hint", async (lockfile, hint) => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { lockfile });
    const { result } = await scanFor(sb);
    expect(result.fs).toHaveLength(1);
    const c = result.fs[0]!;
    expect(c.path).toBe(join(proj, NM));
    expect(c.detector).toBe("node-modules");
    expect(c.kind).toBe("fs");
    expect(c.type).toBe("dir");
    expect(c.regenerate).toBe(`${hint} (in ${proj})`);
    expect(c.reason).toContain(`package.json and ${lockfile} present`);
    expect(c.reason).toContain("no git repository");
  });

  it("records size, entries, age, dev and ino of the directory", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { nodeModules: 20_000, ageDays: 60 });
    const st = statSync(join(proj, NM), { bigint: true });
    const { result } = await scanFor(sb);
    const c = result.fs[0]!;
    expect(c.dev).toBe(st.dev.toString());
    expect(c.ino).toBe(st.ino.toString());
    expect(typeof c.dev).toBe("string");
    expect(c.size).toBeGreaterThanOrEqual(20_000);
    expect(c.entries).toBe(2); // dep/ and dep/index.js
    expect(c.ageDays).toBeGreaterThanOrEqual(60);
    expect(c.ageDays).toBeLessThan(62);
    expect(c.mtimeMs).toBe(Number(st.mtimeMs));
    expect(c.newestMtimeMs).toBeLessThanOrEqual(Date.now() - 59 * DAY);
  });

  it("prefers package-lock.json when several lockfiles exist", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { extraFiles: { "yarn.lock": "# yarn\n", "pnpm-lock.yaml": "lockfileVersion: 9\n" } });
    const { result } = await scanFor(sb);
    expect(result.fs[0]!.regenerate).toBe(`npm ci (in ${proj})`);
  });

  it("accepts a clean git repository whose node_modules is ignored", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { git: true });
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
    expect(result.fs[0]!.reason).toContain("git working tree clean");
  });

  it("accepts a git repo with an untracked but git-ignored file", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { git: "node_modules\n*.log\n" });
    writeText(join(proj, "debug.log"), "noise\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  it("accepts a project without git at all", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "plain"));
    const { result } = await scanFor(sb);
    expect(result.fs).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("finds several projects at different depths", async () => {
    const sb = makeSandbox();
    const a = makeProject(join(sb.projects, "a"));
    const b = makeProject(join(sb.projects, "group", "b"));
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(a, NM), join(b, NM)].sort());
  });

  it("allows a .pem file inside node_modules (non-strict)", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", "test.pem"), "fake test certificate\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  it("accepts hard links whose whole link group lives inside node_modules", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    linkSync(join(proj, NM, "dep", "index.js"), join(proj, NM, "dep", "copy.js"));
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
    // the two links are one allocation: counted once
    const single = makeProject(join(sb.projects, "single"));
    const again = await scanFor(sb);
    const linked = again.result.fs.find((c) => c.path === join(proj, NM))!;
    const plain = again.result.fs.find((c) => c.path === join(single, NM))!;
    expect(linked.size).toBe(plain.size);
  });

  it("does not follow a symlink inside node_modules; the victim is neither counted nor touched", async () => {
    const sb = makeSandbox();
    const victim = join(sb.base, "victim");
    writeBytes(join(victim, "big.bin"), 2_000_000);
    const proj = makeProject(join(sb.projects, "app"));
    symlinkSync(victim, join(proj, NM, "dep", "link"));
    ageTree(proj, 60);
    const before = treeHash(victim);
    const seen: string[] = [];
    const deps = testDeps({ fs: recordingFs(nodeFs, seen) });
    const { result } = await scanFor(sb, {}, deps);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
    expect(result.fs[0]!.size).toBeLessThan(1_000_000);
    expect(treeHash(victim)).toBe(before);
    expect(seen.some((p) => p === victim || p.startsWith(victim + "/"))).toBe(false);
  });
});

describe("node-modules detector: negatives", () => {
  it("skips node_modules without package.json", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "bare");
    writeBytes(join(dir, NM, "dep", "x.js"), 4096);
    ageTree(dir, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(dir, NM))).toEqual(["no package.json next to it, so it is not a recognised project"]);
  });

  it("skips a project without any lockfile", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "nolock"), { lockfile: null });
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["no lockfile, so a reinstall would not be reproducible"]);
  });

  it("skips a symlinked node_modules and never walks its target", async () => {
    const sb = makeSandbox();
    const victim = join(sb.base, "victim-nm");
    writeBytes(join(victim, "dep", "big.js"), 3_000_000);
    const proj = join(sb.projects, "linked");
    writeText(join(proj, "package.json"), "{}\n");
    writeText(join(proj, "package-lock.json"), "{}\n");
    symlinkSync(victim, join(proj, NM));
    ageTree(proj, 60);
    const before = treeHash(victim);
    const seen: string[] = [];
    const { result } = await scanFor(sb, {}, testDeps({ fs: recordingFs(nodeFs, seen) }));
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["node_modules is a symlink (never followed)"]);
    expect(seen.some((p) => p === victim || p.startsWith(victim + "/"))).toBe(false);
    expect(treeHash(victim)).toBe(before);
  });

  it("skips a project touched 5 days ago with the exact age in the reason", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "recent"), { ageDays: 5 });
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["activity 5 days ago, minimum age is 30 days"]);
  });

  it("honours a lower staleDays", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "recent"), { ageDays: 5 });
    const { result } = await scanFor(sb, { staleDays: 3 });
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  const blockers: Array<[string, (proj: string) => void]> = [
    ["package.json", (p) => touch(join(p, "package.json"), 5)],
    ["the lockfile", (p) => touch(join(p, "package-lock.json"), 5)],
    ["a newest source file", (p) => touch(join(p, "src", "index.js"), 5)],
    ["a nested source directory", (p) => touch(join(p, "src"), 5)],
    ["the node_modules top-level mtime", (p) => touch(join(p, NM), 5)],
    ["a file deep inside node_modules", (p) => touch(join(p, NM, "dep", "index.js"), 5)],
  ];
  it.each(blockers)("a fresh mtime on %s blocks the candidate", async (_name, mutate) => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { ageDays: 60 });
    mutate(proj);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["activity 5 days ago, minimum age is 30 days"]);
  });

  it("skips a git repo with a modified tracked file", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "dirty"), { git: true });
    writeText(join(proj, "package.json"), '{"name":"changed"}\n');
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["git working tree has uncommitted or untracked changes"]);
  });

  it("skips a git repo with an untracked, non-ignored file", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "untracked"), { git: true });
    writeText(join(proj, "notes.txt"), "wip\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["git working tree has uncommitted or untracked changes"]);
  });

  it("skips when the git repository root lies outside the configured root", async () => {
    const sb = makeSandbox();
    git(sb.home, "init", "-q", "-b", "main"); // repository above the root (the projects directory)
    const proj = makeProject(join(sb.projects, "app"));
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["its git repository root is outside the configured root"]);
  });

  it("rejects a node_modules that contains a nested .git", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", ".git", "HEAD"), "ref: refs/heads/main\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["contains a nested .git entry"]);
  });

  it("rejects a .env file inside node_modules", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", ".env"), "TOKEN=fake\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["contains an environment file"]);
  });

  it("allows .env.example templates inside node_modules", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", ".env.example"), "TOKEN=\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  it("rejects an id_rsa file inside node_modules", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", "id_rsa"), "not a real key\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["contains an ssh private key"]);
  });

  it("rejects a database data directory marker inside node_modules", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    writeText(join(proj, NM, "dep", "PG_VERSION"), "16\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(skippedFor(result, join(proj, NM))).toEqual(["looks like a database data directory"]);
  });

  it("skips node_modules below the minimum size", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "tiny"));
    const { result } = await scanFor(sb, { minSizeBytes: 50_000_000 });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["below the minimum size of 50000000 bytes"]);
  });

  it("rejects node_modules with more entries than maxEntriesPerCandidate", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "big"));
    for (let i = 0; i < 12; i++) writeText(join(proj, NM, "dep", `f${i}.js`), "x\n");
    ageTree(proj, 60);
    const { result } = await scanFor(sb, { maxEntriesPerCandidate: 6 });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["more than 6 entries"]);
  });

  it("skips a candidate with an open file and reports the open-handle check as performed", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "busy"));
    const open = join(proj, NM, "dep", "index.js");
    const { result } = await scanFor(sb, {}, testDeps({ lsof: [open] }));
    expect(result.fs).toEqual([]);
    expect(result.openHandleCheck).toBe("performed");
    expect(skippedFor(result, join(proj, NM))).toEqual(["a process has files open inside it"]);
  });

  it("an open file elsewhere does not block the candidate", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "idle"));
    const { result } = await scanFor(sb, {}, testDeps({ lsof: [join(sb.base, "elsewhere.txt")] }));
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
    expect(result.openHandleCheck).toBe("performed");
  });

  it("reports the open-handle check as unavailable when lsof is missing", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "app"));
    const { result } = await scanFor(sb, {}, testDeps());
    expect(result.openHandleCheck).toBe("unavailable");
    expect(result.fs).toHaveLength(1);
  });

  it("rejects a file hard-linked to a path outside the candidate", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    linkSync(join(proj, NM, "dep", "index.js"), join(proj, "outside-link.js"));
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["contains hard links shared with files outside the candidate"]);
  });

  it("rejects a tree that crosses a (simulated) file system boundary", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    const marker = join(proj, NM, "dep") + "/";
    const wrapped: FsApi = {
      ...nodeFs,
      lstat: async (p) => {
        const st = await nodeFs.lstat(p);
        if (!p.startsWith(marker)) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)) as typeof st, st, { dev: st.dev + 1n });
      },
    };
    const { result } = await scanFor(sb, {}, testDeps({ fs: wrapped }));
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(proj, NM))).toEqual(["crosses a file system boundary"]);
  });

  it("never scans or offers a project below a protected directory", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, ".config", "app"));
    makeProject(join(sb.projects, "Dropbox", "app"));
    makeProject(join(sb.projects, "secrets-vault", "app"));
    const ok = makeProject(join(sb.projects, "fine"));
    const seen: string[] = [];
    const { result } = await scanFor(sb, {}, testDeps({ fs: recordingFs(nodeFs, seen) }));
    expect(candidatePaths(result)).toEqual([join(ok, NM)]);
    expect(result.skipped).toEqual([]);
    for (const dir of [".config", "Dropbox", "secrets-vault"]) {
      expect(seen.some((p) => p.startsWith(join(sb.projects, dir) + "/"))).toBe(false);
    }
  });

  it("refuses a root that is itself inside a protected path", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "Dropbox", "work"), { recursive: true });
    await expect(makeConfig(sb, { roots: [join(sb.home, "Dropbox", "work")] })).rejects.toThrow(RootsError);
    await expect(makeConfig(sb, { roots: [join(sb.home, "Dropbox", "work")] })).rejects.toThrow(/protected location/);
  });

  it("refuses a root below ~/Documents", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "Documents", "code"), { recursive: true });
    await expect(makeConfig(sb, { roots: [join(sb.home, "Documents", "code")] })).rejects.toThrow(/protected/);
  });

  it("maxDepth limits discovery", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "a", "b", "proj"));
    const shallow = await scanFor(sb, { maxDepth: 2 });
    expect(shallow.result.fs).toEqual([]);
    const deep = await scanFor(sb, { maxDepth: 3 });
    expect(candidatePaths(deep.result)).toEqual([join(proj, NM)]);
  });

  it("a depth-1 project directly under the root is found with maxDepth 1", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "top"));
    const { result } = await scanFor(sb, { maxDepth: 1 });
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  it("does not look inside node_modules for further projects", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"));
    makeProject(join(proj, NM, "dep", "inner"));
    ageTree(proj, 60);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(proj, NM)]);
  });

  it("a git repo that tracks node_modules is clean until a tracked file there changes", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "tracked"), { git: "dist\n" });
    const clean = await scanFor(sb);
    expect(candidatePaths(clean.result)).toEqual([join(proj, NM)]);
    writeText(join(proj, NM, "dep", "index.js"), "modified\n");
    ageTree(proj, 60);
    const dirty = await scanFor(sb);
    expect(dirty.result.fs).toEqual([]);
    expect(skippedFor(dirty.result, join(proj, NM))).toEqual(["git working tree has uncommitted or untracked changes"]);
  });

  it("the scan leaves a git repository byte-for-byte unmodified", async () => {
    const sb = makeSandbox();
    const proj = makeProject(join(sb.projects, "app"), { git: true });
    const before = treeHash(proj);
    await scanFor(sb);
    expect(treeHash(proj)).toBe(before);
    expect(git(proj, "status", "--porcelain")).toBe("");
  });
});
