import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_LOCATIONS, cachePaths } from "../../src/domain/discovery/catalog.js";
import { DOCKER_COMMANDS } from "../../src/domain/discovery/catalog.js";
import { parseDockerDf, parseDockerSize } from "../../src/domain/discovery/eligibility.js";
import { parseWorktreeList } from "../../src/domain/discovery/eligibility.js";
import { ageTree, git, gitInit, makeSandbox, type Sandbox, testDeps, treeHash, writeBytes, writeText } from "../support/helpers.js";
import { scanFor, skippedFor, type TestDeps } from "../support/helpers-detectors.js";

const CANONICAL: string[][] = [
  [".npm", "_cacache"],
  [".local", "share", "pnpm", "store"],
  ["Library", "pnpm", "store"],
  [".cache", "yarn"],
  ["Library", "Caches", "Yarn"],
  [".yarn", "berry", "cache"],
  [".cache", "pip"],
  ["Library", "Caches", "pip"],
  [".cargo", "registry", "cache"],
  ["Library", "Caches", "Homebrew", "downloads"],
  [".cache", "Homebrew", "downloads"],
  [".gradle", "caches"],
];

describe("package-cache detector", () => {
  it("covers exactly the twelve canonical locations", () => {
    expect(CACHE_LOCATIONS).toHaveLength(12);
    expect(cachePaths("/h")).toEqual(CANONICAL.map((r) => join("/h", ...r)));
  });

  it.each(CANONICAL.map((r) => [r.join("/"), r] as const))("finds %s under the configured home", async (_label, rel) => {
    const sb = makeSandbox();
    const dir = join(sb.home, ...rel);
    writeBytes(join(dir, "pkg", "blob.bin"), 8192);
    ageTree(dir, 30);
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs.map((c) => c.path)).toEqual([dir]);
    const c = result.fs[0]!;
    expect(c.detector).toBe("package-cache");
    expect(c.size).toBeGreaterThanOrEqual(8192);
    expect(c.ageDays).toBeGreaterThanOrEqual(30);
    expect(c.reason).toContain("at its default location");
    expect(c.regenerate.length).toBeGreaterThan(0);
  });

  it("is disabled by default", async () => {
    const sb = makeSandbox();
    writeBytes(join(sb.home, ".npm", "_cacache", "x"), 8192);
    ageTree(join(sb.home, ".npm"), 30);
    const { result, config } = await scanFor(sb);
    expect(config.detectors).not.toContain("package-cache");
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("packageCaches true adds the detector to the configuration", async () => {
    const sb = makeSandbox();
    const { config } = await scanFor(sb, { packageCaches: true });
    expect(config.detectors).toContain("package-cache");
  });

  it("does not report a lookalike cache outside the home locations", async () => {
    const sb = makeSandbox();
    const fake = join(sb.projects, ".npm", "_cacache");
    writeBytes(join(fake, "x"), 8192);
    writeBytes(join(sb.projects, "app", ".cache", "pip", "y"), 8192);
    writeBytes(join(sb.base, ".gradle", "caches", "z"), 8192);
    ageTree(sb.projects, 30);
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a symlinked cache directory and never walks its target", async () => {
    const sb = makeSandbox();
    const target = join(sb.base, "real-cache");
    writeBytes(join(target, "blob"), 8192);
    ageTree(target, 30);
    mkdirSync(join(sb.home, ".npm"), { recursive: true });
    symlinkSync(target, join(sb.home, ".npm", "_cacache"));
    const before = treeHash(target);
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(sb.home, ".npm", "_cacache"))).toEqual(["a path component is a symlink (never followed)"]);
    expect(treeHash(target)).toBe(before);
  });

  it("skips a cache below a symlinked parent directory", async () => {
    const sb = makeSandbox();
    const realParent = join(sb.base, "real-npm");
    writeBytes(join(realParent, "_cacache", "blob"), 8192);
    ageTree(realParent, 30);
    symlinkSync(realParent, join(sb.home, ".npm"));
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, join(sb.home, ".npm", "_cacache"))).toEqual(["a path component is a symlink (never followed)"]);
  });

  it("a recent cache is blocked by cacheMinAgeDays", async () => {
    const sb = makeSandbox();
    const dir = join(sb.home, ".cache", "pip");
    writeBytes(join(dir, "w.whl"), 8192);
    ageTree(dir, 2);
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, dir)).toEqual(["activity 2 days ago, minimum age is 7 days"]);
  });

  it("cacheMinAgeDays can be lowered", async () => {
    const sb = makeSandbox();
    const dir = join(sb.home, ".cache", "pip");
    writeBytes(join(dir, "w.whl"), 8192);
    ageTree(dir, 2);
    const { result } = await scanFor(sb, { packageCaches: true, cacheMinAgeDays: 1 });
    expect(result.fs.map((c) => c.path)).toEqual([dir]);
  });

  it("an open file in the cache blocks it", async () => {
    const sb = makeSandbox();
    const dir = join(sb.home, ".cargo", "registry", "cache");
    writeBytes(join(dir, "crate.crate"), 8192);
    ageTree(dir, 30);
    const { result } = await scanFor(sb, { packageCaches: true }, testDeps({ lsof: [join(dir, "crate.crate")] }));
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, dir)).toEqual(["a process has files open inside it"]);
  });

  it("finds several caches at once and leaves the rest of home alone", async () => {
    const sb = makeSandbox();
    const a = join(sb.home, ".npm", "_cacache");
    const b = join(sb.home, ".gradle", "caches");
    writeBytes(join(a, "x"), 8192);
    writeBytes(join(b, "y"), 16384);
    writeText(join(sb.home, ".npm", "keep.txt"), "not part of the cache\n");
    ageTree(join(sb.home, ".npm"), 30);
    ageTree(join(sb.home, ".gradle"), 30);
    const before = treeHash(join(sb.home, ".npm"));
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs.map((c) => c.path)).toEqual([b, a]); // largest first
    expect(treeHash(join(sb.home, ".npm"))).toBe(before);
  });

  it("refuses a cache that contains a nested .git entry", async () => {
    const sb = makeSandbox();
    const dir = join(sb.home, ".cargo", "registry", "cache");
    writeText(join(dir, "src", ".git", "HEAD"), "ref: refs/heads/main\n");
    ageTree(dir, 30);
    const { result } = await scanFor(sb, { packageCaches: true });
    expect(result.fs).toEqual([]);
    expect(skippedFor(result, dir)).toEqual(["contains a nested .git entry"]);
  });
});

describe("parseDockerSize", () => {
  it.each([
    ["1.5GB", 1.5e9],
    ["800MB (66%)", 8e8],
    ["0B", 0],
    ["12kB", 12_000],
    ["12KB", 12_000],
    ["3MB", 3e6],
    ["2GiB", 2 * 1024 ** 3],
    ["512MiB", 512 * 1024 ** 2],
    ["1TB", 1e12],
    ["  7 B", 7],
    ["1.25GB", 1.25e9],
  ])("parses %j as %d bytes", (text, bytes) => {
    expect(parseDockerSize(text)).toBe(bytes);
  });

  it.each(["", "garbage", "GB", "-5MB", "12 parsecs", "1.5.5GB", "NaN"])("returns null for %j", (text) => {
    expect(parseDockerSize(text)).toBeNull();
  });
});

describe("parseDockerDf", () => {
  const rows = [
    '{"Type":"Images","TotalCount":"5","Active":"2","Size":"1.2GB","Reclaimable":"800MB (66%)"}',
    '{"Type":"Containers","TotalCount":"3","Active":"1","Size":"20kB","Reclaimable":"10kB (50%)"}',
    '{"Type":"Local Volumes","TotalCount":"2","Active":"2","Size":"0B","Reclaimable":"0B (0%)"}',
    '{"Type":"Build Cache","TotalCount":"40","Active":"0","Size":"2GB","Reclaimable":"2GB"}',
  ].join("\n");

  it("parses every row with numeric counts and byte sizes", () => {
    expect(parseDockerDf(rows + "\n")).toEqual([
      { type: "Images", total: 5, active: 2, size: 1.2e9, reclaimable: 8e8 },
      { type: "Containers", total: 3, active: 1, size: 20_000, reclaimable: 10_000 },
      { type: "Local Volumes", total: 2, active: 2, size: 0, reclaimable: 0 },
      { type: "Build Cache", total: 40, active: 0, size: 2e9, reclaimable: 2e9 },
    ]);
  });

  it("maps missing or unparseable sizes to null", () => {
    expect(parseDockerDf('{"Type":"Images","TotalCount":1,"Size":"weird"}')).toEqual([{ type: "Images", total: 1, active: 0, size: null, reclaimable: null }]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseDockerDf("")).toEqual([]);
    expect(parseDockerDf("\n\n")).toEqual([]);
  });

  it.each(["not json", "[1,2]\n", "null", '{"NoType":1}', '{"Type":5}', '{"Type":"Images"}\n{broken'])("throws on %j", (text) => {
    expect(() => parseDockerDf(text)).toThrow("unparseable docker system df output");
  });
});

const DF = [
  '{"Type":"Images","TotalCount":"5","Active":"2","Size":"1.2GB","Reclaimable":"800MB (66%)"}',
  '{"Type":"Containers","TotalCount":"3","Active":"1","Size":"20kB","Reclaimable":"10kB (50%)"}',
  '{"Type":"Local Volumes","TotalCount":"2","Active":"2","Size":"900MB","Reclaimable":"500MB (55%)"}',
  '{"Type":"Build Cache","TotalCount":"40","Active":"0","Size":"2GB","Reclaimable":"1.5GB"}',
].join("\n");

const DANGLING = ['{"ID":"a","Size":"100MB"}', '{"ID":"b","Size":"50MB"}'].join("\n");

function dockerHandler(args: readonly string[]): { code?: number; stdout?: string } | undefined {
  const line = args.join(" ");
  if (line === DOCKER_COMMANDS.df.join(" ")) return { stdout: DF };
  if (line === DOCKER_COMMANDS.danglingImages.join(" ")) return { stdout: DANGLING };
  return { code: 1, stdout: "" };
}

function dockerCalls(deps: TestDeps): string[][] {
  return deps.calls.filter((c) => c.command === "docker").map((c) => [...c.args]);
}

describe("docker detector", () => {
  it("is report-only by default: no candidates and only `docker system df` is invoked", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: dockerHandler });
    const { result, config } = await scanFor(sb, {}, deps);
    expect(config.dockerApply).toBe(false);
    expect(result.docker).toEqual([]);
    expect(result.fs).toEqual([]);
    expect(dockerCalls(deps)).toEqual([[...DOCKER_COMMANDS.df]]);
    expect(result.reports.map((r) => r.title)).toEqual(["docker Images", "docker Containers", "docker Local Volumes", "docker Build Cache"]);
    const images = result.reports.find((r) => r.title === "docker Images")!;
    expect(images.size).toBe(1.2e9);
    expect(images.detail).toContain("reclaimable 800000000 bytes");
    expect(images.detail).toContain("docker apply is off");
  });

  it("reports 'docker unavailable' when the CLI is missing", async () => {
    const sb = makeSandbox();
    const { result } = await scanFor(sb, {}, testDeps({ docker: () => undefined }));
    expect(result.docker).toEqual([]);
    expect(result.reports).toEqual([{ detector: "docker", title: "docker unavailable", detail: "the docker CLI was not found" }]);
  });

  it("reports 'docker unavailable' when the daemon errors", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }) });
    const { result } = await scanFor(sb, { dockerApply: true }, deps);
    expect(result.docker).toEqual([]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.title).toBe("docker unavailable");
    expect(result.reports[0]!.detail).toContain("daemon not running");
    expect(dockerCalls(deps)).toEqual([[...DOCKER_COMMANDS.df]]);
  });

  it("reports unparseable output without offering anything", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: () => ({ stdout: "this is not json\n" }) });
    const { result } = await scanFor(sb, { dockerApply: true }, deps);
    expect(result.docker).toEqual([]);
    expect(result.reports[0]!.title).toBe("docker output not understood");
    expect(dockerCalls(deps)).toHaveLength(1);
  });

  it("dockerApply offers build-cache and dangling-images candidates", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: dockerHandler });
    const { result, config } = await scanFor(sb, { dockerApply: true }, deps);
    expect(config.dockerApply).toBe(true);
    expect(result.docker.map((d) => [d.resource, d.size])).toEqual([
      ["build-cache", 1.5e9],
      ["dangling-images", 150_000_000],
    ]);
    for (const d of result.docker) {
      expect(d.kind).toBe("docker");
      expect(d.detector).toBe("docker");
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.regenerate.length).toBeGreaterThan(0);
    }
    expect(result.docker[1]!.reason).toContain("Size is an upper bound");
    expect(result.fs).toEqual([]);
  });

  it("uses exactly the fixed argument lists and nothing else", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: dockerHandler });
    await scanFor(sb, { dockerApply: true }, deps);
    expect(dockerCalls(deps)).toEqual([[...DOCKER_COMMANDS.df], [...DOCKER_COMMANDS.danglingImages]]);
    expect(DOCKER_COMMANDS.df).toEqual(["system", "df", "--format", "{{json .}}"]);
    expect(DOCKER_COMMANDS.danglingImages).toEqual(["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"]);
    expect(DOCKER_COMMANDS.pruneBuildCache).toEqual(["builder", "prune", "--force"]);
    expect(DOCKER_COMMANDS.pruneDanglingImages).toEqual(["image", "prune", "--force"]);
  });

  it("no scan ever sends a destructive or volume-touching docker command", async () => {
    const sb = makeSandbox();
    for (const apply of [false, true]) {
      const deps = testDeps({ docker: dockerHandler });
      await scanFor(sb, { dockerApply: apply }, deps);
      for (const args of dockerCalls(deps)) {
        const line = args.join(" ");
        expect(line).not.toContain("volume");
        expect(line).not.toContain("prune");
        expect(line).not.toContain("--all");
        expect(line).not.toContain("container");
        expect(line).not.toContain("system prune");
        expect(args).not.toContain("-a");
        expect(args).not.toContain("rm");
        expect(args).not.toContain("stop");
        expect(args).not.toContain("kill");
      }
    }
  });

  it("every fixed docker command avoids volumes, containers and -a/--all", () => {
    for (const args of Object.values(DOCKER_COMMANDS)) {
      const line = args.join(" ");
      for (const bad of ["volume", "container", "--all", "system prune", "prune -a", " -a"]) expect(line).not.toContain(bad);
    }
  });

  it("only offers a candidate whose size reaches minSizeBytes", async () => {
    const sb = makeSandbox();
    const big = await scanFor(sb, { dockerApply: true, minSizeBytes: 1_000_000_000 }, testDeps({ docker: dockerHandler }));
    expect(big.result.docker.map((d) => d.resource)).toEqual(["build-cache"]);
    const huge = await scanFor(sb, { dockerApply: true, minSizeBytes: 5_000_000_000 }, testDeps({ docker: dockerHandler }));
    expect(huge.result.docker).toEqual([]);
    const small = await scanFor(sb, { dockerApply: true, minSizeBytes: 120_000_000 }, testDeps({ docker: dockerHandler }));
    expect(small.result.docker.map((d) => d.resource)).toEqual(["build-cache", "dangling-images"]);
  });

  it("offers no dangling-images candidate when the image listing fails", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: (args) => (args[0] === "image" ? { code: 1 } : dockerHandler(args)) });
    const { result } = await scanFor(sb, { dockerApply: true }, deps);
    expect(result.docker.map((d) => d.resource)).toEqual(["build-cache"]);
  });

  it("offers no build-cache candidate when nothing is reclaimable", async () => {
    const sb = makeSandbox();
    const df = DF.replace('"Reclaimable":"1.5GB"', '"Reclaimable":"0B"');
    const deps = testDeps({ docker: (args) => (args[0] === "system" ? { stdout: df } : dockerHandler(args)) });
    const { result } = await scanFor(sb, { dockerApply: true }, deps);
    expect(result.docker.map((d) => d.resource)).toEqual(["dangling-images"]);
  });

  it("restricting detectors without docker never runs docker", async () => {
    const sb = makeSandbox();
    const deps = testDeps({ docker: dockerHandler });
    await scanFor(sb, { detectors: ["node-modules"] }, deps);
    expect(dockerCalls(deps)).toEqual([]);
  });
});

describe("parseWorktreeList", () => {
  it("parses NUL-delimited porcelain records", () => {
    const text = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /elsewhere/wt",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0");
    expect(parseWorktreeList(text)).toEqual([
      { path: "/repo", prunable: null },
      { path: "/elsewhere/wt", prunable: "gitdir file points to non-existent location" },
    ]);
  });

  it("handles a bare `prunable` flag and paths with newlines", () => {
    const text = ["worktree /a\nb", "HEAD x", "prunable", "", ""].join("\0");
    expect(parseWorktreeList(text)).toEqual([{ path: "/a\nb", prunable: "prunable" }]);
  });

  it("returns nothing for empty output and tolerates a missing trailing terminator", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("worktree /only\0HEAD x")).toEqual([{ path: "/only", prunable: null }]);
  });
});

describe("git-worktrees detector", () => {
  function repoWithWorktree(sb: Sandbox) {
    const repo = join(sb.projects, "repo");
    writeText(join(repo, "README.md"), "hello\n");
    gitInit(repo);
    const wt = join(sb.base, "linked-wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    return { repo, wt };
  }

  it("reports a worktree whose directory was deleted as prunable", async () => {
    const sb = makeSandbox();
    const { repo, wt } = repoWithWorktree(sb);
    rmSync(wt, { recursive: true });
    const { result } = await scanFor(sb);
    const reports = result.reports.filter((r) => r.detector === "git-worktrees");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.title).toBe("prunable git worktree");
    expect(reports[0]!.path).toBe(wt);
    expect(reports[0]!.detail).toContain(`repository ${repo}`);
    expect(reports[0]!.detail).toContain("git worktree prune");
    expect(result.fs).toEqual([]);
  });

  it("never removes or prunes the worktree entry", async () => {
    const sb = makeSandbox();
    const { repo, wt } = repoWithWorktree(sb);
    rmSync(wt, { recursive: true });
    const listBefore = git(repo, "worktree", "list", "--porcelain");
    const gitDirBefore = treeHash(join(repo, ".git", "worktrees"));
    await scanFor(sb);
    await scanFor(sb);
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(listBefore);
    expect(git(repo, "worktree", "list")).toContain("linked-wt");
    expect(treeHash(join(repo, ".git", "worktrees"))).toBe(gitDirBefore);
  });

  it("does not report a healthy linked worktree", async () => {
    const sb = makeSandbox();
    const { wt } = repoWithWorktree(sb);
    const { result } = await scanFor(sb);
    expect(result.reports.filter((r) => r.detector === "git-worktrees")).toEqual([]);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature");
  });

  it("reports nothing for a plain repository", async () => {
    const sb = makeSandbox();
    writeText(join(sb.projects, "plain", "a.txt"), "x\n");
    gitInit(join(sb.projects, "plain"));
    const { result } = await scanFor(sb);
    expect(result.reports.filter((r) => r.detector === "git-worktrees")).toEqual([]);
  });

  it("the detectors option can turn it off", async () => {
    const sb = makeSandbox();
    const { wt } = repoWithWorktree(sb);
    rmSync(wt, { recursive: true });
    const { result } = await scanFor(sb, { detectors: ["node-modules"] });
    expect(result.reports).toEqual([]);
  });

  it("reports a prunable worktree once per prunable entry", async () => {
    const sb = makeSandbox();
    const { repo, wt } = repoWithWorktree(sb);
    const wt2 = join(sb.base, "second-wt");
    git(repo, "worktree", "add", "-q", "-b", "other", wt2);
    rmSync(wt, { recursive: true });
    rmSync(wt2, { recursive: true });
    const { result } = await scanFor(sb);
    expect(result.reports.filter((r) => r.detector === "git-worktrees").map((r) => r.path).sort()).toEqual([wt2, wt].sort());
  });
});
