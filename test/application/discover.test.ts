import { beforeEach, describe, expect, it } from "vitest";
import { discoverCandidates, MAX_DIRS_VISITED, type ScanResult } from "../../src/application/discover.js";
import type { Config } from "../../src/domain/model/config.js";
import { DAY_MS, DETECTOR_IDS } from "../../src/domain/model/types.js";
import { FakeClock } from "../support/fakes/clock.js";
import { dfRow, FakeDocker } from "../support/fakes/docker.js";
import { FakeGit } from "../support/fakes/git.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";
import { FakeOpenFiles } from "../support/fakes/open-files.js";

const HOME = "/home/me";
const ROOT = "/home/me/projects";
const clock = new FakeClock();
const ago = (days: number): number => clock.now() - days * DAY_MS;

function config(o: Partial<Config> = {}): Config {
  return {
    roots: [ROOT],
    home: HOME,
    detectors: [...DETECTOR_IDS].filter((d) => d !== "package-cache"),
    dockerApply: false,
    staleDays: 30,
    buildMinAgeDays: 7,
    cacheMinAgeDays: 7,
    minSizeBytes: 1,
    maxDepth: 8,
    maxCandidates: 500,
    maxEntriesPerCandidate: 500_000,
    stateDir: "/state",
    digest: "d",
    ...o,
  };
}

let fs: MemoryFileSystem;
let git: FakeGit;
let open: FakeOpenFiles;
let docker: FakeDocker;

beforeEach(() => {
  fs = new MemoryFileSystem().mkdir(ROOT);
  git = new FakeGit(fs);
  open = new FakeOpenFiles([]);
  docker = new FakeDocker();
});

const discover = (o: Partial<Config> = {}): Promise<ScanResult> => discoverCandidates({ fs, git, openFiles: open, docker, clock }, config(o));

interface ProjectOptions {
  ageDays?: number;
  lock?: string | null;
  nmBytes?: number;
  packageJson?: boolean;
}

/** package.json, lockfile, a source file and node_modules/dep/index.js, all `ageDays` old. */
function project(dir: string, o: ProjectOptions = {}): string {
  const t = ago(o.ageDays ?? 60);
  if (o.packageJson !== false) fs.writeFile(`${dir}/package.json`, { mtimeMs: t });
  if (o.lock !== null) fs.writeFile(`${dir}/${o.lock ?? "package-lock.json"}`, { mtimeMs: t });
  fs.writeFile(`${dir}/src/index.js`, { mtimeMs: t });
  fs.writeFile(`${dir}/node_modules/dep/index.js`, { bytes: o.nmBytes ?? 4096, mtimeMs: t });
  return `${dir}/node_modules`;
}

const paths = (r: ScanResult): string[] => r.fs.map((c) => c.path).sort();
const skippedFor = (r: ScanResult, path: string): string[] => r.skipped.filter((s) => s.path === path).map((s) => s.reason);

describe("DiscoverCandidates: node_modules", () => {
  it("offers the node_modules of a stale project, measured from allocated blocks", async () => {
    const nm = project(`${ROOT}/app`);
    const r = await discover();
    expect(r.fs).toEqual([
      {
        kind: "fs",
        detector: "node-modules",
        path: nm,
        type: "dir",
        dev: "1",
        ino: expect.stringMatching(/^\d+$/),
        size: (8 + 8 + 8) * 512,
        entries: 2,
        mtimeMs: 0,
        newestMtimeMs: ago(60),
        ageDays: 60,
        reason: "project untouched for 60 days; package.json and package-lock.json present; no git repository",
        regenerate: `npm ci (in ${ROOT}/app)`,
      },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.openHandleCheck).toBe("performed");
  });

  it("names the reinstall command after the lockfile present", async () => {
    project(`${ROOT}/a`, { lock: "pnpm-lock.yaml" });
    project(`${ROOT}/b`, { lock: "yarn.lock" });
    const r = await discover();
    expect(r.fs.map((c) => c.regenerate).sort()).toEqual([`pnpm install --frozen-lockfile (in ${ROOT}/a)`, `yarn install --frozen-lockfile (in ${ROOT}/b)`]);
  });

  it("skips a project without package.json", async () => {
    const nm = project(`${ROOT}/app`, { packageJson: false });
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(skippedFor(r, nm)).toEqual(["no package.json next to it, so it is not a recognised project"]);
  });

  it("skips a project without a lockfile", async () => {
    const nm = project(`${ROOT}/app`, { lock: null });
    expect(skippedFor(await discover(), nm)).toEqual(["no lockfile, so a reinstall would not be reproducible"]);
  });

  it("skips a project touched recently, however old its dependencies are", async () => {
    const nm = project(`${ROOT}/app`);
    fs.writeFile(`${ROOT}/app/src/new.js`, { mtimeMs: ago(2) });
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(skippedFor(r, nm)).toEqual(["activity 2 days ago, minimum age is 30 days"]);
  });

  it("folds a recently changed lockfile into the project's activity", async () => {
    const nm = project(`${ROOT}/app`);
    fs.setMtime(`${ROOT}/app/package-lock.json`, ago(5));
    expect(skippedFor(await discover(), nm)).toEqual(["activity 5 days ago, minimum age is 30 days"]);
  });

  it("does not look inside node_modules or .git for project activity", async () => {
    project(`${ROOT}/app`);
    fs.writeFile(`${ROOT}/app/.git/HEAD`, { mtimeMs: ago(1) });
    git.initRepo(`${ROOT}/app`).track(`${ROOT}/app/package.json`).track(`${ROOT}/app/package-lock.json`).track(`${ROOT}/app/src/index.js`).ignore(`${ROOT}/app`, "node_modules");
    const r = await discover();
    expect(paths(r)).toEqual([`${ROOT}/app/node_modules`]);
  });

  it("honours staleDays", async () => {
    project(`${ROOT}/app`, { ageDays: 10 });
    expect((await discover({ staleDays: 30 })).fs).toEqual([]);
    expect(paths(await discover({ staleDays: 5 }))).toEqual([`${ROOT}/app/node_modules`]);
  });

  it("accepts a clean git working tree and says so", async () => {
    const nm = project(`${ROOT}/app`);
    git.initRepo(`${ROOT}/app`).ignore(`${ROOT}/app`, "node_modules");
    for (const f of ["package.json", "package-lock.json", "src/index.js"]) git.track(`${ROOT}/app/${f}`);
    const r = await discover();
    expect(r.fs[0]?.path).toBe(nm);
    expect(r.fs[0]?.reason).toContain("git working tree clean");
  });

  it("skips a dirty working tree, an unreadable one, and a failed status", async () => {
    const nm = project(`${ROOT}/app`);
    git.initRepo(`${ROOT}/app`).ignore(`${ROOT}/app`, "node_modules");
    expect(skippedFor(await discover(), nm)).toEqual(["git working tree has uncommitted or untracked changes"]);
    git.fail("status");
    expect(skippedFor(await discover(), nm)).toContain("git status failed");
  });

  it("skips a project when git cannot be run but a repository exists", async () => {
    const nm = project(`${ROOT}/app`);
    git.initRepo(`${ROOT}/app`);
    git.gitMissing = true;
    expect(skippedFor(await discover(), nm)).toEqual(["inside a git repository but git state could not be read"]);
  });

  it("skips a project whose repository root lies outside the configured root", async () => {
    const nm = project(`${ROOT}/app`);
    git.initRepo(HOME);
    expect(skippedFor(await discover(), nm)).toEqual(["its git repository root is outside the configured root"]);
  });

  it("never follows a node_modules symlink", async () => {
    project(`${ROOT}/real`);
    fs.writeFile(`${ROOT}/app/package.json`, { mtimeMs: ago(60) }).writeFile(`${ROOT}/app/package-lock.json`, { mtimeMs: ago(60) });
    fs.symlink(`${ROOT}/app/node_modules`, `${ROOT}/real/node_modules`);
    const r = await discover();
    expect(paths(r)).toEqual([`${ROOT}/real/node_modules`]);
    expect(skippedFor(r, `${ROOT}/app/node_modules`)).toEqual(["node_modules is a symlink (never followed)"]);
  });

  it("ignores a node_modules that is a plain file", async () => {
    fs.writeFile(`${ROOT}/app/node_modules`).writeFile(`${ROOT}/app/package.json`);
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("refuses a node_modules that contains a nested repository or a secret", async () => {
    const a = project(`${ROOT}/a`);
    fs.mkdir(`${a}/dep/.git`);
    const b = project(`${ROOT}/b`);
    fs.writeFile(`${b}/dep/.env`);
    const r = await discover();
    expect(skippedFor(r, a)).toEqual(["contains a nested .git entry"]);
    expect(skippedFor(r, b)).toEqual(["contains an environment file"]);
  });

  it("allows key-material extensions inside node_modules (packages ship test certificates)", async () => {
    const nm = project(`${ROOT}/a`);
    fs.writeFile(`${nm}/dep/test-cert.pem`);
    expect(paths(await discover())).toEqual([nm]);
  });

  it("refuses a tree that crosses a file system boundary", async () => {
    const nm = project(`${ROOT}/a`);
    fs.mkdir(`${nm}/mount`).setDev(`${nm}/mount`, 9n);
    expect(skippedFor(await discover(), nm)).toEqual(["crosses a file system boundary"]);
  });

  it("refuses a node_modules on another device than its root", async () => {
    const nm = project(`${ROOT}/a`);
    fs.setDev(nm, 9n);
    expect(skippedFor(await discover(), nm)).toEqual(["on a different file system than its root"]);
  });

  it("refuses hard links shared with files outside the candidate, but not links wholly inside", async () => {
    const a = project(`${ROOT}/a`);
    fs.writeFile(`${ROOT}/a/outside.bin`, { bytes: 10, mtimeMs: ago(60) }).link(`${ROOT}/a/outside.bin`, `${a}/dep/linked.bin`);
    const b = project(`${ROOT}/b`);
    fs.writeFile(`${b}/dep/one.bin`, { bytes: 1024, mtimeMs: ago(60) }).link(`${b}/dep/one.bin`, `${b}/dep/two.bin`);
    const r = await discover();
    expect(skippedFor(r, a)).toEqual(["contains hard links shared with files outside the candidate"]);
    expect(paths(r)).toEqual([b]);
    // one 1024-byte file counted once: 2 dirs + index.js + the link group
    expect(r.fs[0]?.size).toBe((8 + 8 + 8 + 2) * 512);
    expect(r.fs[0]?.entries).toBe(4);
  });

  it("applies the minimum size", async () => {
    const nm = project(`${ROOT}/a`, { nmBytes: 512 });
    const r = await discover({ minSizeBytes: 100_000 });
    expect(skippedFor(r, nm)).toEqual(["below the minimum size of 100000 bytes"]);
  });

  it("refuses a tree with more entries than allowed", async () => {
    fs.writeFile(`${ROOT}/a/package.json`, { mtimeMs: ago(60) }).writeFile(`${ROOT}/a/package-lock.json`, { mtimeMs: ago(60) });
    for (const n of ["x", "y", "z"]) fs.writeFile(`${ROOT}/a/node_modules/${n}`, { mtimeMs: ago(60) });
    expect(skippedFor(await discover({ maxEntriesPerCandidate: 2 }), `${ROOT}/a/node_modules`)).toEqual(["more than 2 entries"]);
  });

  it("bounds the scan of a project's own sources by the same limit", async () => {
    const nm = project(`${ROOT}/a`);
    expect(skippedFor(await discover({ maxEntriesPerCandidate: 1 }), nm)).toEqual(["project has more than 1 source entries"]);
  });

  it("skips node_modules with an open file inside, when the check is available", async () => {
    const nm = project(`${ROOT}/a`);
    open.names = [`${nm}/dep/index.js`];
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(skippedFor(r, nm)).toEqual(["a process has files open inside it"]);
  });

  it("reports an unavailable open-handle check and still offers the candidate", async () => {
    project(`${ROOT}/a`);
    open.names = null;
    const r = await discover();
    expect(r.openHandleCheck).toBe("unavailable");
    expect(r.fs).toHaveLength(1);
  });

  it("does not descend into node_modules looking for further projects", async () => {
    const nm = project(`${ROOT}/a`);
    project(`${nm}/dep/inner`);
    expect(paths(await discover())).toEqual([nm]);
  });

  it("refuses a protected path even when it is a configured root", async () => {
    fs.mkdir("/home/me/Documents/proj");
    const nm = project("/home/me/Documents/proj");
    const r = await discover({ roots: ["/home/me/Documents/proj"] });
    expect(r.fs).toEqual([]);
    expect(skippedFor(r, nm)).toEqual(["inside the protected location ~/documents"]);
  });

  it("is disabled when the detector is off", async () => {
    project(`${ROOT}/a`);
    const r = await discover({ detectors: ["docker"] });
    expect(r.fs).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});

describe("DiscoverCandidates: build outputs", () => {
  const out = (dir: string, rel: string, o: { bytes?: number; age?: number } = {}): string => {
    fs.writeFile(`${dir}/${rel}/artifact.bin`, { bytes: o.bytes ?? 4096, mtimeMs: ago(o.age ?? 30) });
    return `${dir}/${rel}`;
  };
  const inRepo = (dir: string, ...ignored: string[]): void => {
    git.initRepo(dir);
    for (const i of ignored) git.ignore(dir, i);
  };

  it("offers a git-ignored, untracked build output", async () => {
    const dist = out(`${ROOT}/app`, "dist");
    inRepo(`${ROOT}/app`, "dist");
    const r = await discover();
    expect(r.fs).toHaveLength(1);
    expect(r.fs[0]).toMatchObject({
      detector: "build-output",
      path: dist,
      ageDays: 30,
      reason: "build output dist, nothing inside modified for 30 days; git-ignored and untracked",
      regenerate: "run the project's build (for example npm run build)",
    });
  });

  it("skips an output that git does not ignore", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    inRepo(`${ROOT}/a`);
    expect(skippedFor(await discover(), dist)).toEqual(["not git-ignored"]);
  });

  it("skips an output when git cannot say whether it is ignored", async () => {
    const build = out(`${ROOT}/b`, "build");
    inRepo(`${ROOT}/b`, "build");
    git.fail("check-ignore");
    expect(skippedFor(await discover(), build)).toEqual(["git check-ignore failed"]);
  });

  it("skips an ignored output that contains tracked files, or when tracking cannot be listed", async () => {
    const dist = out(`${ROOT}/t`, "dist");
    inRepo(`${ROOT}/t`, "dist");
    git.track(`${dist}/artifact.bin`);
    expect(skippedFor(await discover(), dist)).toEqual(["contains files tracked by git"]);
    git.fail("ls-files");
    expect(skippedFor(await discover(), dist)).toEqual(["git ls-files failed"]);
  });

  it("without git, needs an allowlisted name next to a manifest", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    fs.writeFile(`${ROOT}/a/package.json`);
    const bare = out(`${ROOT}/b`, "dist");
    const r = await discover();
    expect(r.fs.map((c) => c.path)).toEqual([dist]);
    expect(r.fs[0]?.reason).toContain("allowlisted name next to package.json (no git repository)");
    expect(skippedFor(r, bare)).toEqual(["no sibling manifest identifies the project type"]);
  });

  it("recognises Python caches by a sibling .py file", async () => {
    const cache = out(`${ROOT}/py`, "__pycache__");
    fs.writeFile(`${ROOT}/py/app.py`);
    expect(paths(await discover())).toEqual([cache]);
  });

  it("a manifest that is not a regular file does not identify the project", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    fs.mkdir(`${ROOT}/a/package.json`);
    expect(skippedFor(await discover(), dist)).toEqual(["no sibling manifest identifies the project type"]);
  });

  it("handles the nested .cache/vite location and requires every segment to be a real directory", async () => {
    const vite = out(`${ROOT}/a`, ".cache/vite");
    fs.writeFile(`${ROOT}/a/package.json`);
    fs.mkdir(`${ROOT}/b`).writeFile(`${ROOT}/b/package.json`).writeFile(`${ROOT}/real/vite/x.js`, { mtimeMs: ago(30) }).symlink(`${ROOT}/b/.cache`, `${ROOT}/real`);
    const r = await discover();
    expect(paths(r)).toEqual([vite]);
    expect(r.skipped.filter((s) => s.path.startsWith(`${ROOT}/b`))).toEqual([]);
  });

  it("skips outputs that are symlinks, never following them", async () => {
    fs.writeFile(`${ROOT}/a/package.json`).writeFile(`${ROOT}/elsewhere/x.js`, { mtimeMs: ago(30) }).symlink(`${ROOT}/a/dist`, `${ROOT}/elsewhere`);
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("refuses key material inside build outputs but not secrets-free ones", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    fs.writeFile(`${dist}/server.pem`);
    fs.writeFile(`${ROOT}/a/package.json`);
    expect(skippedFor(await discover(), dist)).toEqual(["contains key material"]);
  });

  it("honours buildMinAgeDays", async () => {
    const dist = out(`${ROOT}/a`, "dist", { age: 3 });
    fs.writeFile(`${ROOT}/a/package.json`);
    expect(skippedFor(await discover(), dist)).toEqual(["activity 3 days ago, minimum age is 7 days"]);
    expect(paths(await discover({ buildMinAgeDays: 2 }))).toEqual([dist]);
  });

  it("skips outputs in a repository that is unreadable or rooted outside the root", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    inRepo(`${ROOT}/a`, "dist");
    git.gitMissing = true;
    expect(skippedFor(await discover(), dist)).toEqual(["inside a git repository but git state could not be read"]);
    git.gitMissing = false;
    git.repos.clear();
    git.initRepo(HOME).ignore(HOME, "dist");
    expect(skippedFor(await discover(), dist)).toContain("its git repository root is outside the configured root");
  });

  it("does not descend into an accepted build output looking for more", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    fs.writeFile(`${ROOT}/a/package.json`);
    out(dist, "build");
    fs.writeFile(`${dist}/package.json`);
    expect(paths(await discover())).toEqual([dist]);
  });

  it("skips an output with an open file inside", async () => {
    const dist = out(`${ROOT}/a`, "dist");
    fs.writeFile(`${ROOT}/a/package.json`);
    open.names = [`${dist}/artifact.bin`];
    expect(skippedFor(await discover(), dist)).toEqual(["a process has files open inside it"]);
  });
});

describe("DiscoverCandidates: package caches", () => {
  const cache = `${HOME}/.npm/_cacache`;
  const withCaches = { detectors: [...DETECTOR_IDS].filter((d) => d !== "docker") };

  it("offers a documented cache location below home", async () => {
    fs.writeFile(`${cache}/blob`, { bytes: 8192, mtimeMs: ago(30) });
    const r = await discover(withCaches);
    expect(r.fs).toHaveLength(1);
    expect(r.fs[0]).toMatchObject({ detector: "package-cache", path: cache, reason: "npm cache at its default location, nothing inside modified for 30 days" });
  });

  it("is off unless the detector is enabled", async () => {
    fs.writeFile(`${cache}/blob`, { mtimeMs: ago(30) });
    expect((await discover()).fs).toEqual([]);
  });

  it("honours cacheMinAgeDays", async () => {
    fs.writeFile(`${cache}/blob`, { mtimeMs: ago(2) });
    expect(skippedFor(await discover(withCaches), cache)).toEqual(["activity 2 days ago, minimum age is 7 days"]);
  });

  it("warns and scans nothing when home is missing", async () => {
    const r = await discover({ ...withCaches, home: "/nowhere" });
    expect(r.fs).toEqual([]);
    expect(r.warnings).toContain("home directory does not exist; package caches not scanned");
  });

  it("skips a cache reached through a symlink", async () => {
    fs.writeFile(`/data/npm/_cacache/blob`, { mtimeMs: ago(30) }).mkdir(HOME).symlink(`${HOME}/.npm`, "/data/npm");
    const r = await discover(withCaches);
    expect(r.fs).toEqual([]);
    expect(skippedFor(r, cache)).toEqual(["a path component is a symlink (never followed)"]);
  });

  it("skips a cache on another device than home", async () => {
    fs.writeFile(`${cache}/blob`, { mtimeMs: ago(30) }).setDev(`${HOME}/.npm`, 9n);
    expect(skippedFor(await discover(withCaches), cache)).toEqual(["on a different file system than its root"]);
  });

  it("ignores directories that merely look like caches elsewhere", async () => {
    fs.writeFile(`${HOME}/other/.npm/_cacache/blob`, { mtimeMs: ago(30) });
    expect((await discover(withCaches)).fs).toEqual([]);
  });
});

describe("DiscoverCandidates: docker", () => {
  const rows = [
    dfRow("Images", { reclaimable: 10_000_000 }),
    dfRow("Build Cache", { total: 5, active: 0, size: 3_000_000, reclaimable: 3_000_000 }),
  ];

  it("reports docker as unavailable, distinguishing a missing CLI from a failing daemon", async () => {
    const r1 = await discover();
    expect(r1.reports).toEqual([{ detector: "docker", title: "docker unavailable", detail: "the docker CLI was not found" }]);
    docker.usageResult = { status: "unavailable", notInstalled: false };
    expect((await discover()).reports[0]?.detail).toBe("docker system df failed (daemon not running?)");
  });

  it("reports unparseable output", async () => {
    docker.usageResult = { status: "unparseable", message: "unparseable docker system df output" };
    const r = await discover();
    expect(r.reports).toEqual([{ detector: "docker", title: "docker output not understood", detail: "unparseable docker system df output" }]);
    expect(r.docker).toEqual([]);
  });

  it("is report-only by default: usage is listed, nothing is offered", async () => {
    docker.withRows(rows);
    docker.dangling = 50_000_000;
    const r = await discover();
    expect(r.docker).toEqual([]);
    expect(r.reports.map((x) => x.title)).toEqual(["docker Images", "docker Build Cache"]);
    expect(r.reports[1]?.detail).toContain("docker apply is off");
    expect(r.reports[1]?.size).toBe(3_000_000);
  });

  it("with dockerApply offers the build cache and dangling images", async () => {
    docker.withRows(rows);
    docker.dangling = 2_000_000;
    const r = await discover({ dockerApply: true, minSizeBytes: 1_000_000 });
    expect(r.docker.map((d) => [d.resource, d.size])).toEqual([
      ["build-cache", 3_000_000],
      ["dangling-images", 2_000_000],
    ]);
    expect(r.reports.every((x) => !x.detail.includes("apply is off"))).toBe(true);
    expect(docker.pruned).toEqual([]);
  });

  it("offers nothing below the minimum size or when dangling size is unknown", async () => {
    docker.withRows(rows);
    docker.dangling = null;
    expect((await discover({ dockerApply: true, minSizeBytes: 5_000_000 })).docker).toEqual([]);
    expect((await discover({ dockerApply: true, minSizeBytes: 1_000_000 })).docker.map((d) => d.resource)).toEqual(["build-cache"]);
  });

  it("is off when the detector is disabled", async () => {
    docker.withRows(rows);
    const r = await discover({ detectors: ["node-modules"] });
    expect(r.reports).toEqual([]);
  });
});

describe("DiscoverCandidates: worktrees", () => {
  const onlyWorktrees = { detectors: ["git-worktrees" as const] };

  it("reports prunable worktrees and offers nothing", async () => {
    fs.mkdir(`${ROOT}/repo/.git`);
    git.initRepo(`${ROOT}/repo`).addWorktree(`${ROOT}/repo`, { path: `${ROOT}/gone`, prunable: "gitdir file points to non-existent location" });
    const r = await discover(onlyWorktrees);
    expect(r.fs).toEqual([]);
    expect(r.reports).toEqual([
      {
        detector: "git-worktrees",
        title: "prunable git worktree",
        detail: `repository ${ROOT}/repo: gitdir file points to non-existent location. Review, then run 'git worktree prune' yourself; disk-janitor never removes worktrees`,
        path: `${ROOT}/gone`,
      },
    ]);
  });

  it("reports nothing for healthy worktrees or when git cannot list them", async () => {
    fs.mkdir(`${ROOT}/repo/.git`);
    git.initRepo(`${ROOT}/repo`);
    expect((await discover(onlyWorktrees)).reports).toEqual([]);
    git.fail("worktree");
    expect((await discover(onlyWorktrees)).reports).toEqual([]);
  });

  it("ignores a .git that is a file (a linked worktree) or a symlink", async () => {
    fs.writeFile(`${ROOT}/linked/.git`);
    fs.mkdir(`${ROOT}/target`).symlink(`${ROOT}/sym/.git`, `${ROOT}/target`);
    git.initRepo(`${ROOT}/linked`).addWorktree(`${ROOT}/linked`, { path: "/x", prunable: "p" });
    expect((await discover(onlyWorktrees)).reports).toEqual([]);
    expect(git.calls.filter((c) => c.startsWith("worktrees"))).toEqual([]);
  });
});

describe("DiscoverCandidates: the walk", () => {
  it("returns candidates largest first", async () => {
    project(`${ROOT}/small`, { nmBytes: 512 });
    project(`${ROOT}/big`, { nmBytes: 100_000 });
    project(`${ROOT}/mid`, { nmBytes: 10_000 });
    expect((await discover()).fs.map((c) => c.path.split("/")[4])).toEqual(["big", "mid", "small"]);
  });

  it("caps the listed candidates and warns", async () => {
    for (let i = 0; i < 4; i++) project(`${ROOT}/p${i}`, { nmBytes: 1000 * (i + 1) });
    const r = await discover({ maxCandidates: 2 });
    expect(r.fs).toHaveLength(2);
    expect(r.fs.map((c) => c.path)).toEqual([`${ROOT}/p3/node_modules`, `${ROOT}/p2/node_modules`]);
    expect(r.warnings).toEqual(["more than 2 candidates found; only the largest are listed"]);
  });

  it("stops descending at maxDepth", async () => {
    project(`${ROOT}/a/b/c`);
    expect(paths(await discover({ maxDepth: 3 }))).toEqual([`${ROOT}/a/b/c/node_modules`]);
    expect((await discover({ maxDepth: 2 })).fs).toEqual([]);
  });

  it("finds projects in several roots", async () => {
    fs.mkdir("/data/work");
    project(`${ROOT}/a`);
    project("/data/work/b");
    const r = await discover({ roots: [ROOT, "/data/work"] });
    expect(paths(r)).toEqual(["/data/work/b/node_modules", `${ROOT}/a/node_modules`]);
  });

  it("does not follow symlinked directories", async () => {
    project("/elsewhere/app");
    fs.symlink(`${ROOT}/link`, "/elsewhere");
    expect((await discover()).fs).toEqual([]);
  });

  it("does not cross into another file system", async () => {
    project(`${ROOT}/mnt/app`);
    fs.setDev(`${ROOT}/mnt`, 9n);
    expect((await discover()).fs).toEqual([]);
  });

  it("does not descend into protected directories", async () => {
    project(`${ROOT}/.ssh/app`);
    project(`${ROOT}/secrets-store/app`);
    const r = await discover();
    expect(r.fs).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("warns about a root that disappeared or became a symlink, and carries on", async () => {
    fs.mkdir("/data/real").symlink("/data/link", "/data/real");
    project(`${ROOT}/a`);
    const r = await discover({ roots: ["/data/gone", "/data/link", ROOT] });
    expect(r.warnings).toEqual(["root is not a real directory any more: /data/gone", "root is not a real directory any more: /data/link"]);
    expect(r.fs).toHaveLength(1);
  });

  it("counts the directories it visited", async () => {
    fs.mkdir(`${ROOT}/a/b`).mkdir(`${ROOT}/c`);
    expect((await discover()).dirsVisited).toBe(4);
  });

  it("stops after the directory limit and says so", async () => {
    for (let i = 0; i <= MAX_DIRS_VISITED; i++) fs.mkdir(`${ROOT}/d${i}`);
    const r = await discover();
    expect(r.dirsVisited).toBe(MAX_DIRS_VISITED + 1);
    expect(r.warnings).toEqual([`stopped after visiting ${MAX_DIRS_VISITED} directories; the scan is incomplete`]);
  }, 60_000);

  it("never modifies the file system", async () => {
    project(`${ROOT}/a`);
    out_dist();
    await discover();
    expect(fs.renames).toEqual([]);
  });

  it("takes one open-files snapshot per run", async () => {
    project(`${ROOT}/a`);
    project(`${ROOT}/b`);
    await discover();
    expect(open.snapshots).toBe(1);
  });

  it("reads the age from the injected clock", async () => {
    const nm = project(`${ROOT}/a`, { ageDays: 40 });
    const later = new FakeClock(clock.now() + 100 * DAY_MS);
    const r = await discoverCandidates({ fs, git, openFiles: open, docker, clock: later }, config());
    expect(r.fs.find((c) => c.path === nm)?.ageDays).toBe(140);
  });
});

function out_dist(): void {
  fs.writeFile(`${ROOT}/a/dist/x.js`, { mtimeMs: ago(30) }).writeFile(`${ROOT}/a/package.json`);
}
