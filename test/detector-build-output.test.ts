import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_FIRST_SEGMENTS, BUILD_OUTPUTS } from "../src/detectors/buildOutput.js";
import { nodeFs } from "../src/infrastructure/fs/node-fs.js";
import { ageTree, git, gitInit, makeSandbox, testDeps, treeHash, writeBytes, writeText } from "./helpers.js";
import { candidatePaths, recordingFs, scanFor, skippedFor } from "./helpers-detectors.js";

interface Case {
  name: string;
  rel: string[];
  /** Sibling file that identifies the project type without git. */
  manifest: string;
  ignore: string;
}

const CASES: Case[] = [
  { name: ".next", rel: [".next"], manifest: "package.json", ignore: ".next/" },
  { name: "dist", rel: ["dist"], manifest: "package.json", ignore: "dist/" },
  { name: "build", rel: ["build"], manifest: "package.json", ignore: "build/" },
  { name: "target", rel: ["target"], manifest: "Cargo.toml", ignore: "target/" },
  { name: ".turbo", rel: [".turbo"], manifest: "turbo.json", ignore: ".turbo/" },
  { name: ".cache/vite", rel: [".cache", "vite"], manifest: "package.json", ignore: ".cache/" },
  { name: "__pycache__", rel: ["__pycache__"], manifest: "app.py", ignore: "__pycache__/" },
  { name: ".pytest_cache", rel: [".pytest_cache"], manifest: "pyproject.toml", ignore: ".pytest_cache/" },
  { name: ".mypy_cache", rel: [".mypy_cache"], manifest: "mypy.ini", ignore: ".mypy_cache/" },
  { name: "coverage", rel: ["coverage"], manifest: "package.json", ignore: "coverage/" },
];

/** A project directory holding one build output of `bytes` bytes, everything aged `age` days. */
function buildProject(dir: string, c: Case, opts: { git?: string | false; manifest?: boolean; age?: number; bytes?: number } = {}): string {
  const out = join(dir, ...c.rel);
  writeBytes(join(out, "artifact.bin"), opts.bytes ?? 4096);
  if (opts.manifest !== false) writeText(join(dir, c.manifest), "x\n");
  if (opts.git !== false && opts.git !== undefined) gitInit(dir, opts.git);
  ageTree(dir, opts.age ?? 30);
  return out;
}

describe("build-output allowlist", () => {
  it("is exactly the documented set of names", () => {
    expect(BUILD_OUTPUTS.map((b) => b.rel.join("/")).sort()).toEqual(CASES.map((c) => c.name).sort());
    expect([...BUILD_FIRST_SEGMENTS].sort()).toEqual([".cache", ".mypy_cache", ".next", ".pytest_cache", ".turbo", "__pycache__", "build", "coverage", "dist", "target"]);
  });
});

describe("build-output detector: positives", () => {
  it.each(CASES)("offers $name when it is git-ignored and untracked", async (c) => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), c, { git: c.ignore });
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([out]);
    const cand = result.fs[0]!;
    expect(cand.detector).toBe("build-output");
    expect(cand.reason).toContain("git-ignored and untracked");
    expect(cand.reason).toContain(`build output ${c.rel.join("/")}`);
    expect(cand.size).toBeGreaterThanOrEqual(4096);
    expect(cand.entries).toBe(1);
  });

  it.each(CASES)("offers $name without git when its sibling manifest exists", async (c) => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), c);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([out]);
    expect(result.fs[0]!.reason).toContain(`allowlisted name next to ${c.manifest} (no git repository)`);
  });

  it("offers a __pycache__ next to any .py file even without a manifest name", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "py");
    writeText(join(dir, "tool.py"), "print(1)\n");
    writeBytes(join(dir, "__pycache__", "tool.cpython-312.pyc"), 2048);
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(dir, "__pycache__")]);
    expect(result.fs[0]!.reason).toContain("next to tool.py");
  });

  it("records dev, ino and age of the build directory", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!, { age: 20 });
    const { result } = await scanFor(sb);
    const c = result.fs[0]!;
    expect(c.path).toBe(out);
    expect(c.dev).toMatch(/^[0-9]+$/);
    expect(c.ino).toMatch(/^[0-9]+$/);
    expect(c.ageDays).toBeGreaterThanOrEqual(20);
    expect(c.regenerate).toContain("build");
  });

  it("uses the tool-specific regenerate hint", async () => {
    const sb = makeSandbox();
    buildProject(join(sb.projects, "rust"), CASES[3]!);
    buildProject(join(sb.projects, "next"), CASES[0]!);
    const { result } = await scanFor(sb);
    const byName = Object.fromEntries(result.fs.map((c) => [c.path.split("/").at(-1), c.regenerate]));
    expect(byName["target"]).toBe("cargo build or mvn package");
    expect(byName[".next"]).toBe("next build");
  });

  it("offers several outputs of one project as separate candidates", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "multi");
    writeText(join(dir, "package.json"), "{}\n");
    writeBytes(join(dir, "dist", "a.js"), 4096);
    writeBytes(join(dir, "coverage", "lcov.info"), 4096);
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(dir, "coverage"), join(dir, "dist")]);
  });

  it("does not offer a git-ignored build directory in a clean repo's other directories", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    writeBytes(join(dir, "dist", "a.js"), 4096);
    writeBytes(join(dir, "sub", "dist", "b.js"), 4096);
    gitInit(dir, "/dist/\n"); // only the top-level dist is ignored
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(candidatePaths(result)).toEqual([join(dir, "dist")]);
    expect(skippedFor(result, join(dir, "sub", "dist"))).toEqual(["not git-ignored"]);
  });
});

describe("build-output detector: negatives", () => {
  it("skips a build directory in a git repo that does not ignore it", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!, { git: "node_modules\n" });
    // dist was committed by gitInit (not ignored), so it is tracked
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["not git-ignored"]);
  });

  it("skips an untracked, non-ignored build directory in a git repo", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    gitInit(dir, "node_modules\n");
    writeBytes(join(dir, "dist", "a.js"), 4096);
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(dir, "dist"))).toEqual(["not git-ignored"]);
  });

  it("skips a git-ignored directory that contains a force-added tracked file", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!, { git: "dist/\n" });
    writeText(join(out, "keep.txt"), "tracked on purpose\n");
    git(dir, "add", "-f", "dist/keep.txt");
    git(dir, "commit", "-q", "-m", "force add");
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    // git itself reports a directory with tracked content as not ignored; either reason keeps it safe
    expect(skippedFor(result, out)).toHaveLength(1);
    expect(skippedFor(result, out)[0]).toMatch(/^(not git-ignored|contains files tracked by git)$/);
  });

  it("skips an allowlisted name without git and without a manifest", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!, { manifest: false });
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["no sibling manifest identifies the project type"]);
  });

  it("a manifest for another ecosystem does not identify the project", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "Cargo.toml"), "[package]\n");
    writeBytes(join(dir, "dist", "a.js"), 4096);
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(dir, "dist"))).toEqual(["no sibling manifest identifies the project type"]);
  });

  it("never offers names outside the allowlist, even when git-ignored", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    for (const name of ["out", "tmp", "output", "bin", "obj", ".cache/other", "vendor", "logs"]) writeBytes(join(dir, name, "x.bin"), 4096);
    gitInit(dir, "out/\ntmp/\noutput/\nbin/\nobj/\n.cache/\nvendor/\nlogs/\n");
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("does not match names that merely contain an allowlisted name", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    for (const name of ["dist-old", "mybuild", "Dist", "targets", "coverage2", ".next-backup"]) writeBytes(join(dir, name, "x.bin"), 4096);
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("blocks a build directory with recent content (buildMinAgeDays)", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!, { age: 2 });
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["activity 2 days ago, minimum age is 7 days"]);
  });

  it("buildMinAgeDays 0 offers fresh output", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!, { age: 0 });
    const { result } = await scanFor(sb, { buildMinAgeDays: 0 });
    expect(candidatePaths(result)).toEqual([out]);
  });

  it("one fresh file inside an otherwise old build directory blocks it", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!, { age: 40 });
    writeText(join(out, "fresh.js"), "new\n"); // mtime = now
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["activity 0 days ago, minimum age is 7 days"]);
  });

  it("ignores a symlinked build directory and never walks its target", async () => {
    const sb = makeSandbox();
    const victim = join(sb.base, "victim-dist");
    writeBytes(join(victim, "big.bin"), 2_000_000);
    ageTree(victim, 30);
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    symlinkSync(victim, join(dir, "dist"));
    ageTree(dir, 30);
    const before = treeHash(victim);
    const seen: string[] = [];
    const { result } = await scanFor(sb, {}, testDeps({ fs: recordingFs(nodeFs, seen) }));
    expect(result.fs).toEqual([]);
    expect(seen.some((p) => p === victim || p.startsWith(victim + "/"))).toBe(false);
    expect(treeHash(victim)).toBe(before);
  });

  it("ignores .cache/vite when .cache itself is a symlink", async () => {
    const sb = makeSandbox();
    const real = join(sb.base, "real-cache");
    writeBytes(join(real, "vite", "x.bin"), 4096);
    ageTree(real, 30);
    const dir = join(sb.projects, "proj");
    writeText(join(dir, "package.json"), "{}\n");
    symlinkSync(real, join(dir, ".cache"));
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
  });

  it("rejects key material (.pem) inside a build output (strict)", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!);
    writeText(join(out, "cert.pem"), "fake test certificate\n");
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["contains key material"]);
  });

  it("rejects a file named like a secret inside a build output", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!);
    writeText(join(out, "credentials.json"), "{}\n");
    ageTree(dir, 30);
    const { result } = await scanFor(sb);
    expect(skippedFor(result, out)).toEqual(["contains a file named like a secret"]);
  });

  it("rejects a build output with a .env file or nested .git inside", async () => {
    const sb = makeSandbox();
    const a = join(sb.projects, "a");
    const b = join(sb.projects, "b");
    const outA = buildProject(a, CASES[1]!);
    const outB = buildProject(b, CASES[1]!);
    writeText(join(outA, ".env"), "X=1\n");
    writeText(join(outB, ".git", "HEAD"), "ref: refs/heads/main\n");
    ageTree(a, 30);
    ageTree(b, 30);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, outA)).toEqual(["contains an environment file"]);
    expect(skippedFor(result, outB)).toEqual(["contains a nested .git entry"]);
  });

  it("skips build output when the git root is outside the configured root", async () => {
    const sb = makeSandbox();
    git(sb.home, "init", "-q", "-b", "main");
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["its git repository root is outside the configured root"]);
  });

  it("skips build output below the minimum size", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[1]!);
    const { result } = await scanFor(sb, { minSizeBytes: 10_000_000 });
    expect(skippedFor(result, out)).toEqual(["below the minimum size of 10000000 bytes"]);
  });

  it("skips build output with an open file", async () => {
    const sb = makeSandbox();
    const out = buildProject(join(sb.projects, "proj"), CASES[3]!);
    const { result } = await scanFor(sb, {}, testDeps({ lsof: [join(out, "artifact.bin")] }));
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, out)).toEqual(["a process has files open inside it"]);
  });

  it("does not offer build output under a protected directory", async () => {
    const sb = makeSandbox();
    buildProject(join(sb.projects, ".config", "proj"), CASES[1]!);
    buildProject(join(sb.projects, "OneDrive", "proj"), CASES[1]!);
    const { result } = await scanFor(sb);
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("the detectors option can turn build-output off", async () => {
    const sb = makeSandbox();
    buildProject(join(sb.projects, "proj"), CASES[1]!);
    const { result } = await scanFor(sb, { detectors: ["node-modules"] });
    expect(result.fs).toEqual([]);
  });

  it("leaves the build directory untouched when scanning", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    buildProject(dir, CASES[1]!, { git: "dist/\n" });
    const before = treeHash(dir);
    await scanFor(sb);
    expect(treeHash(dir)).toBe(before);
  });

  it("a removed output between runs is simply not offered", async () => {
    const sb = makeSandbox();
    const dir = join(sb.projects, "proj");
    const out = buildProject(dir, CASES[1]!);
    expect((await scanFor(sb)).result.fs).toHaveLength(1);
    rmSync(out, { recursive: true });
    expect((await scanFor(sb)).result.fs).toEqual([]);
  });
});
