import { describe, expect, it } from "vitest";
import { BUILD_OUTPUTS, CACHE_LOCATIONS, LOCKFILES } from "../../../src/domain/discovery/catalog.js";
import {
  CACHE_SYMLINK_REFUSAL,
  GIT_IGNORED_ORIGIN,
  HOME_MISSING_WARNING,
  assessFsCandidate,
  buildOutputRule,
  directoryRefusal,
  findManifest,
  ignoreRefusal,
  manifestNamesToCheck,
  manifestOrigin,
  nodeModulesActivityMs,
  nodeModulesPresence,
  nodeModulesRule,
  packageCacheRule,
  packageJsonRefusal,
  repositoryRefusal,
  selectLockfile,
  trackedFilesRefusal,
  worktreeCleanRefusal,
  type CandidateRule,
  type DirectoryFacts,
  type FoundLockfile,
} from "../../../src/domain/discovery/eligibility.js";
import { DAY_MS } from "../../../src/domain/model/types.js";

const NOW = Date.UTC(2026, 5, 1);
const DIR: DirectoryFacts = { kind: "directory", dev: 5n, ino: 99n, mtimeMs: NOW - 100 * DAY_MS };

describe("directoryRefusal", () => {
  const ctx = { homes: ["/home/me"], baseDev: 5n };
  it("accepts a real unprotected directory on the base device", () => {
    expect(directoryRefusal("/home/me/projects/a/node_modules", DIR, ctx)).toBeNull();
  });
  it.each([
    ["missing", "cannot stat"],
    ["symlink", "is a symlink (never followed)"],
    ["other", "is not a directory"],
  ] as const)("refuses a %s", (kind, reason) => {
    expect(directoryRefusal("/home/me/p/x", { ...DIR, kind }, ctx)).toBe(reason);
  });
  it("refuses protected paths with the protection reason", () => {
    expect(directoryRefusal("/home/me/Documents/p/node_modules", DIR, ctx)).toBe("inside the protected location ~/documents");
    expect(directoryRefusal("/home/me/.ssh/x", DIR, ctx)).toContain("protected");
  });
  it("refuses another device", () => {
    expect(directoryRefusal("/home/me/p/x", { ...DIR, dev: 6n }, ctx)).toBe("on a different file system than its root");
  });
  it("checks the kind before protection and protection before the device", () => {
    expect(directoryRefusal("/home/me/.ssh/x", { ...DIR, kind: "symlink", dev: 9n }, ctx)).toBe("is a symlink (never followed)");
    expect(directoryRefusal("/home/me/.ssh/x", { ...DIR, dev: 9n }, ctx)).toContain("protected");
  });
});

describe("assessFsCandidate", () => {
  const rule: CandidateRule = { detector: "build-output", strict: true, minAgeDays: 7, reasonFor: (a) => `idle ${a}d`, regenerate: "rebuild" };
  const base = {
    rule,
    path: "/r/app/dist",
    directory: DIR,
    tree: { size: 10_000, entries: 4, newestMtimeMs: NOW - 30 * DAY_MS },
    minSizeBytes: 1000,
    nowMs: NOW,
    activityMs: 0,
    openFiles: { available: true, names: [] as string[] },
  };

  it("accepts and builds a validated candidate", () => {
    const r = assessFsCandidate(base);
    expect(r).toEqual({
      ok: true,
      value: {
        kind: "fs",
        detector: "build-output",
        path: "/r/app/dist",
        type: "dir",
        dev: "5",
        ino: "99",
        size: 10_000,
        entries: 4,
        mtimeMs: DIR.mtimeMs,
        newestMtimeMs: NOW - 30 * DAY_MS,
        ageDays: 30,
        reason: "idle 30d",
        regenerate: "rebuild",
      },
    });
  });

  it("refuses below the minimum size, and accepts exactly the minimum", () => {
    expect(assessFsCandidate({ ...base, minSizeBytes: 10_001 })).toEqual({ ok: false, reason: "below the minimum size of 10001 bytes" });
    expect(assessFsCandidate({ ...base, minSizeBytes: 10_000 }).ok).toBe(true);
  });

  it("refuses activity that is too recent and reports whole days", () => {
    const r = assessFsCandidate({ ...base, tree: { ...base.tree, newestMtimeMs: NOW - 3 * DAY_MS - 5000 } });
    expect(r).toEqual({ ok: false, reason: "activity 3 days ago, minimum age is 7 days" });
  });

  it("accepts activity exactly at the minimum age", () => {
    const r = assessFsCandidate({ ...base, tree: { ...base.tree, newestMtimeMs: NOW - 7 * DAY_MS } });
    expect(r.ok && r.value.ageDays).toBe(7);
  });

  it("takes the newest of external activity, tree mtime and the directory's own mtime", () => {
    const young = assessFsCandidate({ ...base, activityMs: NOW - DAY_MS });
    expect(young).toEqual({ ok: false, reason: "activity 1 days ago, minimum age is 7 days" });
    const dirYoung = assessFsCandidate({ ...base, directory: { ...DIR, mtimeMs: NOW - 2 * DAY_MS } });
    expect(dirYoung.ok).toBe(false);
  });

  it("treats activity in the future as too recent and reports an age of zero days", () => {
    const r = assessFsCandidate({ ...base, rule: { ...rule, minAgeDays: 0 }, tree: { ...base.tree, newestMtimeMs: NOW + 5 * DAY_MS } });
    expect(r).toEqual({ ok: false, reason: "activity 0 days ago, minimum age is 0 days" });
  });

  it("refuses when a process has a file open inside, or on the path itself", () => {
    const why = "a process has files open inside it";
    expect(assessFsCandidate({ ...base, openFiles: { available: true, names: ["/r/app/dist/x.js"] } })).toEqual({ ok: false, reason: why });
    expect(assessFsCandidate({ ...base, openFiles: { available: true, names: ["/r/app/dist"] } })).toEqual({ ok: false, reason: why });
  });

  it("ignores open files elsewhere, including a sibling with a shared name prefix", () => {
    expect(assessFsCandidate({ ...base, openFiles: { available: true, names: ["/r/app/dist2/x", "/r/app"] } }).ok).toBe(true);
  });

  it("checks size before age before open handles", () => {
    const all = { ...base, minSizeBytes: 10 ** 9, tree: { ...base.tree, newestMtimeMs: NOW }, openFiles: { available: true, names: ["/r/app/dist"] } };
    expect(assessFsCandidate(all)).toMatchObject({ reason: expect.stringContaining("minimum size") });
    expect(assessFsCandidate({ ...all, minSizeBytes: 1 })).toMatchObject({ reason: expect.stringContaining("minimum age") });
  });

  it("surfaces candidate invariant violations instead of producing a bad candidate", () => {
    expect(() => assessFsCandidate({ ...base, path: "relative/dist" })).toThrow();
  });
});

describe("repositoryRefusal", () => {
  it("refuses an unreadable repository", () => {
    expect(repositoryRefusal({ state: "unavailable" }, "/r")).toBe("inside a git repository but git state could not be read");
  });
  it("refuses a repository rooted outside the configured root, and accepts the root itself", () => {
    expect(repositoryRefusal({ state: "repo", toplevel: "/" }, "/r")).toBe("its git repository root is outside the configured root");
    expect(repositoryRefusal({ state: "repo", toplevel: "/rr" }, "/r")).toBe("its git repository root is outside the configured root");
    expect(repositoryRefusal({ state: "repo", toplevel: "/r" }, "/r")).toBeNull();
    expect(repositoryRefusal({ state: "repo", toplevel: "/r/a" }, "/r")).toBeNull();
  });
  it("accepts no repository", () => {
    expect(repositoryRefusal({ state: "none" }, "/r")).toBeNull();
  });
});

describe("node_modules eligibility", () => {
  const lock = (i: number, mtimeMs = 0): FoundLockfile => ({ lockfile: LOCKFILES[i]!, mtimeMs });

  it("presence: nothing to report when absent or not a directory", () => {
    expect(nodeModulesPresence("missing")).toBeNull();
    expect(nodeModulesPresence("other")).toBeNull();
    expect(nodeModulesPresence("directory")).toEqual({ ok: true, value: undefined });
    expect(nodeModulesPresence("symlink")).toEqual({ ok: false, reason: "node_modules is a symlink (never followed)" });
  });

  it("requires package.json as a regular file", () => {
    const why = "no package.json next to it, so it is not a recognised project";
    expect(packageJsonRefusal(null)).toBe(why);
    expect(packageJsonRefusal({ isFile: false, mtimeMs: 0 })).toBe(why);
    expect(packageJsonRefusal({ isFile: true, mtimeMs: 0 })).toBeNull();
  });

  it("requires a lockfile and prefers the first in catalogue order", () => {
    expect(selectLockfile([])).toEqual({ ok: false, reason: "no lockfile, so a reinstall would not be reproducible" });
    const r = selectLockfile([lock(0), lock(2)]);
    expect(r.ok && r.value.lockfile.name).toBe("package-lock.json");
  });

  it("requires a clean working tree", () => {
    expect(worktreeCleanRefusal(true)).toBeNull();
    expect(worktreeCleanRefusal(false)).toBe("git working tree has uncommitted or untracked changes");
    expect(worktreeCleanRefusal("error")).toBe("git status failed");
  });

  it("activity is the newest of sources, package.json and every lockfile", () => {
    const f = { sourceNewestMs: 10, packageJsonMtimeMs: 30, lockfiles: [lock(0, 20), lock(2, 50)] };
    expect(nodeModulesActivityMs(f)).toBe(50);
    expect(nodeModulesActivityMs({ ...f, lockfiles: [] })).toBe(30);
  });

  it("describes the candidate, with the git note and the reinstall command", () => {
    const facts = { projectDir: "/r/app", lockfile: lock(3), lockfiles: [lock(3)], packageJsonMtimeMs: 0, sourceNewestMs: 0, staleDays: 45 };
    const clean = nodeModulesRule({ ...facts, repoState: "repo" });
    expect(clean).toMatchObject({ detector: "node-modules", strict: false, minAgeDays: 45, regenerate: "pnpm install --frozen-lockfile (in /r/app)" });
    expect(clean.reasonFor(60)).toBe("project untouched for 60 days; package.json and pnpm-lock.yaml present; git working tree clean");
    expect(nodeModulesRule({ ...facts, repoState: "none" }).reasonFor(1)).toContain("no git repository");
  });
});

describe("build output eligibility", () => {
  it("git ignore states", () => {
    expect(ignoreRefusal("ignored")).toBeNull();
    expect(ignoreRefusal("not-ignored")).toBe("not git-ignored");
    expect(ignoreRefusal("error")).toBe("git check-ignore failed");
  });
  it("tracked files", () => {
    expect(trackedFilesRefusal(false)).toBeNull();
    expect(trackedFilesRefusal(true)).toBe("contains files tracked by git");
    expect(trackedFilesRefusal("error")).toBe("git ls-files failed");
  });

  const spec = (name: string) => BUILD_OUTPUTS.find((b) => b.rel.join("/") === name)!;

  it("identifies the project by the first manifest in the spec's order", () => {
    const r = findManifest(spec("dist"), ["pyproject.toml", "package.json"]);
    expect(r).toEqual({ ok: true, value: "package.json" });
  });
  it("refuses without a manifest", () => {
    expect(findManifest(spec("target"), ["package.json", "README.md"])).toEqual({ ok: false, reason: "no sibling manifest identifies the project type" });
  });
  it("python caches accept any .py sibling but other outputs do not", () => {
    expect(findManifest(spec("__pycache__"), ["x.txt", "app.py"])).toEqual({ ok: true, value: "app.py" });
    expect(findManifest(spec("dist"), ["app.py"]).ok).toBe(false);
    expect(findManifest(spec("__pycache__"), [])).toMatchObject({ ok: false });
  });
  it("manifestNamesToCheck narrows the directory listing to relevant names", () => {
    const names = ["package.json", "a.py", "README", "Cargo.toml"];
    expect(manifestNamesToCheck(spec("dist"), names)).toEqual(["package.json"]);
    expect(manifestNamesToCheck(spec("__pycache__"), names)).toEqual(["a.py"]);
    expect(manifestNamesToCheck(spec(".pytest_cache"), names)).toEqual(["a.py"]);
  });
  it("describes the candidate", () => {
    const rule = buildOutputRule(spec(".cache/vite"), GIT_IGNORED_ORIGIN, 7);
    expect(rule).toMatchObject({ detector: "build-output", strict: true, minAgeDays: 7, regenerate: "vite (cache refills automatically)" });
    expect(rule.reasonFor(9)).toBe("build output .cache/vite, nothing inside modified for 9 days; git-ignored and untracked");
    expect(buildOutputRule(spec("dist"), manifestOrigin("package.json"), 0).reasonFor(1)).toContain("allowlisted name next to package.json (no git repository)");
  });
});

describe("package cache eligibility", () => {
  it("describes the candidate with its label and uses the cache detector, not strict", () => {
    const loc = CACHE_LOCATIONS[0]!;
    const rule = packageCacheRule(loc, 14);
    expect(rule).toMatchObject({ detector: "package-cache", strict: false, minAgeDays: 14, regenerate: loc.regenerate });
    expect(rule.reasonFor(20)).toBe("npm cache at its default location, nothing inside modified for 20 days");
  });
  it("exposes the user-visible refusal texts", () => {
    expect(CACHE_SYMLINK_REFUSAL).toBe("a path component is a symlink (never followed)");
    expect(HOME_MISSING_WARNING).toBe("home directory does not exist; package caches not scanned");
  });
});
