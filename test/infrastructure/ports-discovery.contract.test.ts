import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DockerPort, GitPort, OpenFilesPort } from "../../src/application/ports/discovery.js";
import { DOCKER_COMMANDS } from "../../src/domain/discovery/catalog.js";
import { openPathUnder, type DockerDfRow } from "../../src/domain/discovery/facts.js";
import type { DockerCandidate } from "../../src/domain/model/types.js";
import { nodeFs } from "../../src/infrastructure/fs/node-fs.js";
import type { CommandResult, CommandRunner } from "../../src/infrastructure/process/command-runner.js";
import { createDocker } from "../../src/infrastructure/process/docker.js";
import { createGit, GIT_ENV, GIT_PREFIX } from "../../src/infrastructure/process/git.js";
import { createLsof, LSOF_ARGS } from "../../src/infrastructure/process/lsof.js";
import { git as runGit, makeSandbox, testDeps, type Sandbox } from "../support/helpers.js";
import { FakeDocker } from "../support/fakes/docker.js";
import { FakeGit } from "../support/fakes/git.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";
import { FakeOpenFiles } from "../support/fakes/open-files.js";

const call = (command: string, args: readonly string[]) => ({ command, args: [...args] });

// =============================================================================================
// OpenFilesPort
// =============================================================================================

interface OpenFilesWorld {
  port: OpenFilesPort;
  /** Make the system report these open paths; null: lsof is not installed. */
  setOpen(names: string[] | null): void;
}

function fakeOpenFilesWorld(): OpenFilesWorld {
  const fake = new FakeOpenFiles(null);
  return { port: fake, setOpen: (n) => void (fake.names = n) };
}

/** lsof -F n output for the given paths: process and descriptor records interleaved with names. */
const lsofOutput = (names: string[]): string => names.map((p, i) => `p${100 + i}\nfcwd\nn${p}\n`).join("");

function lsofAdapterWorld(): OpenFilesWorld {
  let open: string[] | null = null;
  const run: CommandRunner = async () =>
    open === null ? { code: null, stdout: "", stderr: "", error: "ENOENT" } : { code: 0, stdout: lsofOutput(open), stderr: "" };
  return { port: createLsof(run), setOpen: (n) => void (open = n) };
}

describe.each([
  ["FakeOpenFiles", fakeOpenFilesWorld],
  ["lsof adapter", lsofAdapterWorld],
])("OpenFilesPort contract: %s", (_name, make) => {
  it("is unavailable when the system cannot list open files", async () => {
    const w = make();
    w.setOpen(null);
    expect(await w.port.snapshot()).toEqual({ available: false, names: [] });
  });

  it("lists the open paths when it can", async () => {
    const w = make();
    w.setOpen(["/work/app/dist/a.js", "/work/other"]);
    const snap = await w.port.snapshot();
    expect(snap.available).toBe(true);
    expect([...snap.names].sort()).toEqual(["/work/app/dist/a.js", "/work/other"]);
  });

  it("supports the open-path question the use case asks", async () => {
    const w = make();
    w.setOpen(["/work/app/dist/a.js"]);
    const snap = await w.port.snapshot();
    expect(openPathUnder(snap, "/work/app/dist")).toBe("/work/app/dist/a.js");
    expect(openPathUnder(snap, "/work/app/dist/a.js")).toBe("/work/app/dist/a.js");
    expect(openPathUnder(snap, "/work/app/dis")).toBeNull();
    expect(openPathUnder(snap, "/work/app/dist/a.js/x")).toBeNull();
  });

  it("sees changes between snapshots", async () => {
    const w = make();
    w.setOpen(["/a/1"]);
    expect((await w.port.snapshot()).names).toEqual(["/a/1"]);
    w.setOpen(["/a/2"]);
    expect((await w.port.snapshot()).names).toEqual(["/a/2"]);
  });

  it("keeps paths with spaces", async () => {
    const w = make();
    w.setOpen(["/work/my project/file name.txt"]);
    expect((await w.port.snapshot()).names).toEqual(["/work/my project/file name.txt"]);
  });
});

describe("lsof adapter specifics", () => {
  it("runs exactly lsof -nP -w -F n with a timeout and no shell", async () => {
    const calls: Array<{ command: string; args: readonly string[]; timeoutMs?: number | undefined }> = [];
    const run: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, timeoutMs: opts?.timeoutMs });
      return { code: 0, stdout: "n/x\n", stderr: "" };
    };
    await createLsof(run).snapshot();
    expect(calls).toEqual([{ command: "lsof", args: ["-nP", "-w", "-F", "n"], timeoutMs: 30_000 }]);
    expect([...LSOF_ARGS]).toEqual(["-nP", "-w", "-F", "n"]);
  });

  it("keeps only absolute paths: sockets, pipes and process records are ignored", async () => {
    const stdout = ["p1", "fcwd", "n/work/a", "f3", "nTCP *:80 (LISTEN)", "n*:443", "n->0x1234", "npipe", "n/work/b c", "", "n/work/last-without-newline"].join("\n");
    const port = createLsof(async () => ({ code: 0, stdout, stderr: "" }));
    expect(await port.snapshot()).toEqual({ available: true, names: ["/work/a", "/work/b c", "/work/last-without-newline"] });
  });

  it.each<[string, Partial<CommandResult>]>([
    ["not installed", { code: null, error: "ENOENT" }],
    ["timed out", { code: null, error: "timeout", stdout: "n/partial\n" }],
    ["no output", { code: 0, stdout: "" }],
    ["exit without output", { code: 1, stdout: "" }],
  ])("is unavailable when lsof is %s", async (_label, res) => {
    const port = createLsof(async () => ({ code: 0, stdout: "", stderr: "", ...res }));
    expect(await port.snapshot()).toEqual({ available: false, names: [] });
  });

  it("treats lsof's partial-failure exit code with output as available (it is best effort)", async () => {
    const port = createLsof(async () => ({ code: 1, stdout: "n/work/a\n", stderr: "warning" }));
    expect(await port.snapshot()).toEqual({ available: true, names: ["/work/a"] });
  });
});

// =============================================================================================
// GitPort
// =============================================================================================

interface GitWorld {
  port: GitPort;
  /** Port of the same kind in which the git executable cannot be run. */
  portWithoutGit(): GitPort;
  root: string;
  /** An initialised repository with one commit. */
  repo(rel: string): Promise<string>;
  /** An ordinary directory that is not inside any repository. */
  plain(rel: string): Promise<string>;
  /** An untracked file. */
  write(path: string): Promise<void>;
  /** Commit these (existing) files. */
  commit(repo: string, ...files: string[]): Promise<void>;
  /** Ignore every path component called `name` (and commit that rule). */
  ignore(repo: string, name: string): Promise<void>;
  /** Change a committed file. */
  modify(path: string): Promise<void>;
  /** A linked worktree whose directory was deleted afterwards (git marks it prunable). */
  prunableWorktree(repo: string, rel: string): Promise<string>;
  /** The repository's own config defines `key`. */
  setConfig(repo: string, key: string, value: string): Promise<void>;
}

function fakeGitWorld(): GitWorld {
  const mem = new MemoryFileSystem().mkdir("/work");
  const fake = new FakeGit(mem);
  const w: GitWorld = {
    port: fake,
    portWithoutGit: () => {
      const g = new FakeGit(mem);
      for (const r of fake.repos) g.initRepo(r);
      g.gitMissing = true;
      return g;
    },
    root: "/work",
    async repo(rel) {
      const dir = join("/work", rel);
      mem.mkdir(join(dir, ".git"));
      fake.initRepo(dir);
      return dir;
    },
    async plain(rel) {
      const dir = join("/work", rel);
      mem.mkdir(dir);
      return dir;
    },
    async write(path) {
      mem.writeFile(path);
    },
    async commit(_repo, ...files) {
      for (const f of files) fake.track(f);
    },
    async ignore(repo, name) {
      mem.writeFile(join(repo, ".gitignore"));
      fake.track(join(repo, ".gitignore")).ignore(repo, name);
    },
    async modify(path) {
      fake.modify(path);
    },
    async prunableWorktree(repo, rel) {
      const path = join(dirname(repo), rel);
      fake.addWorktree(repo, { path, prunable: "gitdir file points to non-existent location" });
      return path;
    },
    async setConfig(repo, key) {
      fake.setConfig(repo, key);
    },
  };
  return w;
}

const realRun = testDeps().run;

function realGitWorld(): GitWorld {
  const sb = makeSandbox();
  const root = join(sb.base, "world");
  mkdirSync(root, { recursive: true });
  const out = (cwd: string, ...args: string[]) => void runGit(cwd, ...args);
  const missingGit: CommandRunner = async () => ({ code: null, stdout: "", stderr: "", error: "ENOENT" });
  return {
    port: createGit(realRun, nodeFs),
    portWithoutGit: () => createGit(missingGit, nodeFs),
    root,
    async repo(rel) {
      const dir = join(root, rel);
      mkdirSync(dir, { recursive: true });
      out(dir, "init", "-q", "-b", "main");
      out(dir, "commit", "-q", "--allow-empty", "-m", "init");
      return dir;
    },
    async plain(rel) {
      const dir = join(root, rel);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    async write(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "x\n");
    },
    async commit(repo, ...files) {
      out(repo, "add", "--", ...files);
      out(repo, "commit", "-q", "-m", "c");
    },
    async ignore(repo, name) {
      appendFileSync(join(repo, ".gitignore"), `${name}\n`);
      out(repo, "add", ".gitignore");
      out(repo, "commit", "-q", "-m", "ignore");
    },
    async modify(path) {
      appendFileSync(path, "changed\n");
    },
    async prunableWorktree(repo, rel) {
      const path = join(dirname(repo), rel);
      out(repo, "worktree", "add", "-q", path, "-b", `wt-${rel}`);
      rmSync(path, { recursive: true, force: true });
      return path;
    },
    async setConfig(repo, key, value) {
      out(repo, "config", "--local", key, value);
    },
  };
}

describe.each([
  ["FakeGit", fakeGitWorld],
  ["git CLI adapter", realGitWorld],
])("GitPort contract: %s", (_name, make) => {
  describe("repoInfo", () => {
    it("finds the repository containing a directory, from its root or any subdirectory", async () => {
      const w = make();
      const repo = await w.repo("proj");
      await w.write(join(repo, "src", "deep", "f"));
      expect(await w.port.repoInfo(repo, w.root)).toEqual({ state: "repo", toplevel: repo });
      expect(await w.port.repoInfo(join(repo, "src", "deep"), w.root)).toEqual({ state: "repo", toplevel: repo });
    });

    it("says none for a directory outside any repository", async () => {
      const w = make();
      const dir = await w.plain("plain");
      expect(await w.port.repoInfo(dir, w.root)).toEqual({ state: "none" });
    });

    it("tells apart two sibling projects", async () => {
      const w = make();
      const a = await w.repo("a");
      const plain = await w.plain("b");
      expect((await w.port.repoInfo(a, w.root)).state).toBe("repo");
      expect((await w.port.repoInfo(plain, w.root)).state).toBe("none");
    });

    it("is unavailable, not none, when git cannot run but a repository marker exists", async () => {
      const w = make();
      const repo = await w.repo("proj");
      await w.write(join(repo, "src", "f"));
      expect(await w.portWithoutGit().repoInfo(join(repo, "src"), w.root)).toEqual({ state: "unavailable" });
    });

    it("is none when git cannot run and no repository marker exists up to the ceiling", async () => {
      const w = make();
      const dir = await w.plain("plain");
      expect(await w.portWithoutGit().repoInfo(dir, w.root)).toEqual({ state: "none" });
    });

    it("does not look for repository markers above the ceiling", async () => {
      const w = make();
      const outer = await w.repo("outer");
      const inner = join(outer, "inner");
      await w.write(join(inner, "f"));
      expect(await w.portWithoutGit().repoInfo(inner, inner)).toEqual({ state: "none" });
      expect(await w.portWithoutGit().repoInfo(inner, outer)).toEqual({ state: "unavailable" });
    });
  });

  describe("isIgnored", () => {
    it("is ignored for an ignored directory and anything inside it", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist", "sub", "a.js"));
      await w.ignore(repo, "dist");
      expect(await w.port.isIgnored(repo, join(repo, "dist"))).toBe("ignored");
      expect(await w.port.isIgnored(repo, join(repo, "dist", "sub", "a.js"))).toBe("ignored");
    });

    it("is not ignored for a path no rule matches", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist", "a.js"));
      await w.write(join(repo, "src", "a.js"));
      await w.ignore(repo, "build");
      expect(await w.port.isIgnored(repo, join(repo, "dist"))).toBe("not-ignored");
      expect(await w.port.isIgnored(repo, join(repo, "src", "a.js"))).toBe("not-ignored");
    });

    it("is an error outside a repository", async () => {
      const w = make();
      const dir = await w.plain("plain");
      await w.write(join(dir, "dist", "a.js"));
      expect(await w.port.isIgnored(dir, join(dir, "dist"))).toBe("error");
    });
  });

  describe("hasTrackedFiles", () => {
    it("is true when a tracked file is at or below the path", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist", "tracked.js"));
      await w.commit(repo, join(repo, "dist", "tracked.js"));
      expect(await w.port.hasTrackedFiles(repo, join(repo, "dist"))).toBe(true);
      expect(await w.port.hasTrackedFiles(repo, join(repo, "dist", "tracked.js"))).toBe(true);
    });

    it("is false for untracked or ignored content", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist", "a.js"));
      await w.write(join(repo, "src", "kept.js"));
      await w.commit(repo, join(repo, "src", "kept.js"));
      await w.ignore(repo, "dist");
      expect(await w.port.hasTrackedFiles(repo, join(repo, "dist"))).toBe(false);
    });

    it("does not count tracked files of a sibling directory with a similar name", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist2", "a.js"));
      await w.write(join(repo, "dist", "b.js"));
      await w.commit(repo, join(repo, "dist2", "a.js"));
      expect(await w.port.hasTrackedFiles(repo, join(repo, "dist"))).toBe(false);
    });

    it("is an error outside a repository", async () => {
      const w = make();
      const dir = await w.plain("plain");
      await w.write(join(dir, "dist", "a.js"));
      expect(await w.port.hasTrackedFiles(dir, join(dir, "dist"))).toBe("error");
    });
  });

  describe("worktreeClean", () => {
    it("is clean right after a commit", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "a.js"));
      await w.commit(repo, join(repo, "a.js"));
      expect(await w.port.worktreeClean(repo)).toBe(true);
    });

    it("is dirty with an untracked file, however deep", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "a", "b", "new.js"));
      expect(await w.port.worktreeClean(repo)).toBe(false);
    });

    it("is dirty with a modified tracked file", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "a.js"));
      await w.commit(repo, join(repo, "a.js"));
      await w.modify(join(repo, "a.js"));
      expect(await w.port.worktreeClean(repo)).toBe(false);
    });

    it("ignores untracked files that are ignored", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.ignore(repo, "node_modules");
      await w.write(join(repo, "node_modules", "dep", "index.js"));
      expect(await w.port.worktreeClean(repo)).toBe(true);
    });

    it("only considers the directory asked about, not its siblings", async () => {
      const w = make();
      const repo = await w.repo("mono");
      await w.write(join(repo, "pkg-a", "a.js"));
      await w.write(join(repo, "pkg-b", "b.js"));
      await w.commit(repo, join(repo, "pkg-a", "a.js"));
      expect(await w.port.worktreeClean(join(repo, "pkg-a"))).toBe(true);
      expect(await w.port.worktreeClean(join(repo, "pkg-b"))).toBe(false);
    });

    it("is an error outside a repository", async () => {
      const w = make();
      expect(await w.port.worktreeClean(await w.plain("plain"))).toBe("error");
    });
  });

  describe("worktrees", () => {
    it("lists the main worktree as not prunable", async () => {
      const w = make();
      const repo = await w.repo("p");
      expect(await w.port.worktrees(repo)).toEqual([{ path: repo, prunable: null }]);
    });

    it("marks a linked worktree whose directory is gone as prunable", async () => {
      const w = make();
      const repo = await w.repo("p");
      const gone = await w.prunableWorktree(repo, "gone");
      const list = await w.port.worktrees(repo);
      expect(list?.map((e) => e.path)).toEqual([repo, gone]);
      expect(list?.[0]?.prunable).toBeNull();
      expect(typeof list?.[1]?.prunable).toBe("string");
      expect(list?.[1]?.prunable?.length).toBeGreaterThan(0);
    });

    it("is null when git cannot list worktrees (not a repository)", async () => {
      const w = make();
      expect(await w.port.worktrees(await w.plain("plain"))).toBeNull();
    });
  });

  describe("untrusted repositories (their own config defines a command)", () => {
    const HOSTILE: Array<[string, string]> = [
      ["filter.evil.clean", "touch /nonexistent/x; cat"],
      ["filter.evil.smudge", "cat"],
      ["filter.evil.process", "cat"],
      ["core.fsmonitor", "/bin/true"],
      ["core.hooksPath", "/tmp/hooks"],
      ["core.sshCommand", "ssh -o x"],
      ["core.pager", "less"],
      ["core.editor", "vi"],
      ["core.askPass", "/bin/true"],
      ["core.gitProxy", "/bin/true"],
      ["diff.word.textconv", "cat"],
      ["diff.word.command", "cat"],
      ["merge.custom.driver", "cat %A"],
      ["include.path", "../other"],
      ["includeIf.gitdir:/x/.path", "../other"],
      ["credential.helper", "store"],
      ["credential.https://example.com.helper", "store"],
    ];

    it.each(HOSTILE)("refuses a repository whose config defines %s and names the key", async (key, value) => {
      const w = make();
      const repo = await w.repo("p");
      await w.setConfig(repo, key, value);
      const info = await w.port.repoInfo(repo, w.root);
      expect(info.state).toBe("untrusted");
      expect(info.state === "untrusted" && info.key.toLowerCase()).toBe(key.toLowerCase());
    });

    it("refuses from any subdirectory of the repository", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "src", "f"));
      await w.setConfig(repo, "filter.evil.clean", "cat");
      expect((await w.port.repoInfo(join(repo, "src"), w.root)).state).toBe("untrusted");
    });

    it("answers no question about such a repository, even when asked directly", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.write(join(repo, "dist", "a.js"));
      await w.ignore(repo, "dist");
      await w.setConfig(repo, "core.pager", "less");
      expect(await w.port.isIgnored(repo, join(repo, "dist"))).toBe("error");
      expect(await w.port.hasTrackedFiles(repo, join(repo, "dist"))).toBe("error");
      expect(await w.port.worktreeClean(repo)).toBe("error");
      expect(await w.port.worktrees(repo)).toBeNull();
    });

    it("still trusts a repository with ordinary configuration", async () => {
      const w = make();
      const repo = await w.repo("p");
      await w.setConfig(repo, "user.name", "someone");
      await w.setConfig(repo, "remote.origin.url", "https://example.invalid/r.git");
      await w.setConfig(repo, "diff.algorithm", "patience");
      await w.setConfig(repo, "merge.ff", "false");
      expect(await w.port.repoInfo(repo, w.root)).toEqual({ state: "repo", toplevel: repo });
      expect(await w.port.worktreeClean(repo)).toBe(true);
    });
  });
});

describe("git CLI adapter hardening", () => {
  type Call = { command: string; args: readonly string[]; cwd?: string | undefined; env?: Record<string, string> | undefined; timeoutMs?: number | undefined };
  function recording(): { run: CommandRunner; calls: Call[] } {
    const calls: Call[] = [];
    const run: CommandRunner = (command, args, opts) => {
      calls.push({ command, args, cwd: opts?.cwd, env: opts?.env, timeoutMs: opts?.timeoutMs });
      return realRun(command, args, opts);
    };
    return { run, calls };
  }

  const PREFIX = [
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
  ];
  const ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ASKPASS: "/bin/false",
  };

  function plainRepo(): { sb: Sandbox; repo: string } {
    const sb = makeSandbox();
    const repo = join(sb.base, "r");
    mkdirSync(repo, { recursive: true });
    runGit(repo, "init", "-q", "-b", "main");
    runGit(repo, "commit", "-q", "--allow-empty", "-m", "i");
    return { sb, repo };
  }

  it("prefixes every command with the hardening options and passes the locked-down environment", async () => {
    const { sb, repo } = plainRepo();
    const { run, calls } = recording();
    const port = createGit(run, nodeFs);
    await port.repoInfo(repo, sb.base);
    await port.isIgnored(repo, join(repo, "x"));
    await port.hasTrackedFiles(repo, join(repo, "x"));
    await port.worktreeClean(repo);
    await port.worktrees(repo);
    expect(calls.map((c) => c.args.slice(PREFIX.length))).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["config", "--list", "-z", "--show-scope", "--no-includes"],
      ["check-ignore", "-q", "--", join(repo, "x")],
      ["ls-files", "-z", "--cached", "--", join(repo, "x")],
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."],
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    for (const c of calls) {
      expect(c.command).toBe("git");
      expect(c.args.slice(0, PREFIX.length)).toEqual(PREFIX);
      expect(c.cwd).toBe(repo);
      expect(c.timeoutMs).toBe(60_000);
      expect(c.env).toEqual(ENV);
    }
    expect([...GIT_PREFIX]).toEqual(PREFIX);
    expect({ ...GIT_ENV }).toEqual(ENV);
  });

  it("reads the configuration once per directory per adapter, and never executes anything to do so", async () => {
    const { repo } = plainRepo();
    const { run, calls } = recording();
    const port = createGit(run, nodeFs);
    await port.worktreeClean(repo);
    await port.worktreeClean(repo);
    await port.isIgnored(repo, join(repo, "a"));
    expect(calls.filter((c) => c.args.includes("config"))).toHaveLength(1);
  });

  it("covers config.worktree: a command defined there is refused", async () => {
    const { sb, repo } = plainRepo();
    runGit(repo, "config", "--local", "extensions.worktreeConfig", "true");
    expect(await createGit(realRun, nodeFs).repoInfo(repo, sb.base)).toEqual({ state: "repo", toplevel: repo });
    runGit(repo, "config", "--worktree", "filter.evil.clean", "cat");
    expect(await createGit(realRun, nodeFs).repoInfo(repo, sb.base)).toEqual({ state: "untrusted", key: "filter.evil.clean" });
  });

  it("treats a repository whose config cannot be read as unavailable", async () => {
    const run: CommandRunner = async (_c, args) =>
      args.includes("rev-parse") ? { code: 0, stdout: "/r\n", stderr: "" } : { code: 128, stdout: "", stderr: "fatal: bad config line" };
    expect(await createGit(run, new MemoryFileSystem().mkdir("/r")).repoInfo("/r", "/")).toEqual({ state: "unavailable" });
  });

  it("never runs a repository-configured fsmonitor program: the repository is refused instead", async () => {
    const { sb, repo } = plainRepo();
    const marker = join(sb.base, "fsmonitor-ran");
    writeFileSync(join(repo, ".git", "hook.sh"), `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
    runGit(repo, "config", "core.fsmonitor", join(repo, ".git", "hook.sh"));

    const port = createGit(realRun, nodeFs);
    expect(await port.repoInfo(repo, sb.base)).toEqual({ state: "untrusted", key: "core.fsmonitor" });
    expect(await port.worktreeClean(repo)).toBe("error");
    expect(existsSync(marker)).toBe(false);

    // sanity: plain git does run the configured program, so the assertions above mean something
    execFileSync("git", ["status", "--porcelain"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not consult the user's global gitignore: a path ignored only there is not ignored", async () => {
    const { sb, repo } = plainRepo();
    const excludes = join(sb.base, "global-ignore");
    writeFileSync(excludes, "ignored-by-global/\n");
    mkdirSync(join(repo, "ignored-by-global"));
    writeFileSync(join(repo, "ignored-by-global", "f"), "x");
    // control: git configured with that excludes file does ignore it
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync("git", ["-c", `core.excludesFile=${excludes}`, "check-ignore", "-q", join(repo, "ignored-by-global")], { cwd: repo, env });
    const withUserConfig: CommandRunner = (command, args, opts) => realRun(command, args, { ...opts, env: { ...opts?.env, HOME: sb.base, XDG_CONFIG_HOME: sb.base } });
    mkdirSync(join(sb.base, "git"), { recursive: true });
    writeFileSync(join(sb.base, "git", "config"), `[core]\n\texcludesFile = ${excludes}\n`);
    writeFileSync(join(sb.base, ".gitconfig"), `[core]\n\texcludesFile = ${excludes}\n`);
    expect(await createGit(withUserConfig, nodeFs).isIgnored(repo, join(repo, "ignored-by-global"))).toBe("not-ignored");
  });

  it("answers from exit codes: 0 ignored, 1 not ignored, anything else an error", async () => {
    const script = (code: number | null): CommandRunner => async (_c, args) =>
      args.includes("check-ignore") ? { code, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    const dummy = new MemoryFileSystem();
    expect(await createGit(script(0), dummy).isIgnored("/r", "/r/x")).toBe("ignored");
    expect(await createGit(script(1), dummy).isIgnored("/r", "/r/x")).toBe("not-ignored");
    expect(await createGit(script(128), dummy).isIgnored("/r", "/r/x")).toBe("error");
    expect(await createGit(script(null), dummy).isIgnored("/r", "/r/x")).toBe("error");
  });

  it("reports a repository whose toplevel cannot be resolved as unavailable", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "/vanished\n", stderr: "" });
    expect(await createGit(run, new MemoryFileSystem().mkdir("/r")).repoInfo("/r", "/")).toEqual({ state: "unavailable" });
  });

  it("resolves a symlinked toplevel to its real path", async () => {
    const mem = new MemoryFileSystem().mkdir("/real/repo").symlink("/link", "/real/repo");
    const run: CommandRunner = async () => ({ code: 0, stdout: "/link\n", stderr: "" });
    expect(await createGit(run, mem).repoInfo("/link/sub", "/")).toEqual({ state: "repo", toplevel: "/real/repo" });
  });
});

// =============================================================================================
// DockerPort
// =============================================================================================

interface DockerScenario {
  installed: boolean;
  daemonUp: boolean;
  rows: DockerDfRow[];
  garbageDf: boolean;
  /** Sizes in bytes of dangling images; null: listing fails. */
  dangling: number[] | null;
  pruneFails: boolean;
}

interface DockerWorld {
  port: DockerPort;
  script(s: Partial<DockerScenario>): void;
  /** Which resources were pruned, in order. */
  pruned(): Array<DockerCandidate["resource"]>;
}

const DEFAULT_SCENARIO: DockerScenario = { installed: true, daemonUp: true, rows: [], garbageDf: false, dangling: [], pruneFails: false };

function fakeDockerWorld(): DockerWorld {
  const fake = new FakeDocker();
  return {
    port: fake,
    script(partial) {
      const s = { ...DEFAULT_SCENARIO, ...partial };
      fake.usageResult = !s.installed
        ? { status: "unavailable", notInstalled: true }
        : !s.daemonUp
          ? { status: "unavailable", notInstalled: false }
          : s.garbageDf
            ? { status: "unparseable", message: "unparseable docker system df output" }
            : { status: "ok", rows: s.rows };
      fake.dangling = s.dangling === null ? null : s.dangling.reduce((a, b) => a + b, 0);
      fake.pruneResult = s.pruneFails ? { ok: false, detail: "failed" } : { ok: true, detail: "Total reclaimed space: 1MB" };
    },
    pruned: () => fake.pruned,
  };
}

interface DockerCli {
  run: CommandRunner;
  calls: Array<{ command: string; args: readonly string[]; timeoutMs?: number | undefined }>;
  script(s: Partial<DockerScenario>): void;
}

/** A scripted docker CLI: answers by argument vector, like the real thing would. */
function dockerCli(): DockerCli {
  let s: DockerScenario = DEFAULT_SCENARIO;
  const calls: DockerCli["calls"] = [];
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const run: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, timeoutMs: opts?.timeoutMs });
    if (command !== "docker" || !s.installed) return { code: null, stdout: "", stderr: "", error: "ENOENT" };
    if (!s.daemonUp) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (same(args, DOCKER_COMMANDS.df)) {
      if (s.garbageDf) return { code: 0, stdout: "this is not json\n", stderr: "" };
      const lines = s.rows.map((r) => JSON.stringify({ Type: r.type, TotalCount: r.total, Active: r.active, ...(r.size !== null ? { Size: `${r.size}B` } : {}), ...(r.reclaimable !== null ? { Reclaimable: `${r.reclaimable}B (50%)` } : {}) }));
      return { code: 0, stdout: lines.join("\n") + (lines.length ? "\n" : ""), stderr: "" };
    }
    if (same(args, DOCKER_COMMANDS.danglingImages)) {
      if (s.dangling === null) return { code: 1, stdout: "", stderr: "error" };
      return { code: 0, stdout: s.dangling.map((n) => JSON.stringify({ ID: "x", Size: `${n}B` })).join("\n"), stderr: "" };
    }
    if (same(args, DOCKER_COMMANDS.pruneBuildCache) || same(args, DOCKER_COMMANDS.pruneDanglingImages)) {
      return s.pruneFails ? { code: 1, stdout: "", stderr: "prune refused by daemon" } : { code: 0, stdout: "Total reclaimed space: 1MB\n", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "unknown command" };
  };
  return { run, calls, script: (p) => void (s = { ...DEFAULT_SCENARIO, ...p }) };
}

function dockerAdapterWorld(): DockerWorld & { cli: DockerCli } {
  const cli = dockerCli();
  return {
    cli,
    port: createDocker(cli.run),
    script: cli.script,
    pruned: () =>
      cli.calls.flatMap((c) =>
        c.args.join(" ") === DOCKER_COMMANDS.pruneBuildCache.join(" ")
          ? ["build-cache" as const]
          : c.args.join(" ") === DOCKER_COMMANDS.pruneDanglingImages.join(" ")
            ? ["dangling-images" as const]
            : [],
      ),
  };
}

const ROWS: DockerDfRow[] = [
  { type: "Images", total: 12, active: 3, size: 4_000_000_000, reclaimable: 2_500_000_000 },
  { type: "Build Cache", total: 40, active: 0, size: 900_000_000, reclaimable: 900_000_000 },
  { type: "Local Volumes", total: 2, active: 2, size: 100, reclaimable: null },
];

describe.each([
  ["FakeDocker", fakeDockerWorld],
  ["docker CLI adapter", dockerAdapterWorld],
])("DockerPort contract: %s", (_name, make) => {
  describe("usage", () => {
    it("returns one row per resource type", async () => {
      const w = make();
      w.script({ rows: ROWS });
      expect(await w.port.usage()).toEqual({ status: "ok", rows: ROWS });
    });

    it("returns no rows for a daemon with nothing in it", async () => {
      const w = make();
      w.script({ rows: [] });
      expect(await w.port.usage()).toEqual({ status: "ok", rows: [] });
    });

    it("distinguishes a missing CLI from a daemon that is down", async () => {
      const w = make();
      w.script({ installed: false });
      expect(await w.port.usage()).toEqual({ status: "unavailable", notInstalled: true });
      w.script({ daemonUp: false });
      expect(await w.port.usage()).toEqual({ status: "unavailable", notInstalled: false });
    });

    it("flags output it cannot understand", async () => {
      const w = make();
      w.script({ garbageDf: true });
      expect(await w.port.usage()).toEqual({ status: "unparseable", message: "unparseable docker system df output" });
    });
  });

  describe("danglingImageBytes", () => {
    it("sums the dangling images", async () => {
      const w = make();
      w.script({ dangling: [1_000_000, 2_500_000] });
      expect(await w.port.danglingImageBytes()).toBe(3_500_000);
    });
    it("is zero when there are none", async () => {
      const w = make();
      w.script({ dangling: [] });
      expect(await w.port.danglingImageBytes()).toBe(0);
    });
    it("is null when the listing fails", async () => {
      const w = make();
      w.script({ dangling: null });
      expect(await w.port.danglingImageBytes()).toBeNull();
    });
  });

  describe("prune", () => {
    it("prunes exactly the requested resource and reports success with output", async () => {
      const w = make();
      w.script({});
      const out = await w.port.prune("build-cache");
      expect(out.ok).toBe(true);
      expect(out.detail).toContain("reclaimed");
      expect(w.pruned()).toEqual(["build-cache"]);
      await w.port.prune("dangling-images");
      expect(w.pruned()).toEqual(["build-cache", "dangling-images"]);
    });

    it("reports failure with a non-empty explanation and does not throw", async () => {
      const w = make();
      w.script({ pruneFails: true });
      const out = await w.port.prune("dangling-images");
      expect(out.ok).toBe(false);
      expect(out.detail.length).toBeGreaterThan(0);
    });
  });
});

describe("docker CLI adapter specifics", () => {
  it("executes only the fixed argument lists, never anything built from input", async () => {
    const w = dockerAdapterWorld();
    w.script({ rows: ROWS, dangling: [5] });
    await w.port.usage();
    await w.port.danglingImageBytes();
    await w.port.prune("build-cache");
    await w.port.prune("dangling-images");
    expect(w.cli.calls.map((c) => call(c.command, c.args))).toEqual([
      call("docker", ["system", "df", "--format", "{{json .}}"]),
      call("docker", ["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"]),
      call("docker", ["builder", "prune", "--force"]),
      call("docker", ["image", "prune", "--force"]),
    ]);
  });

  it("gives queries 30 seconds and prunes ten minutes", async () => {
    const w = dockerAdapterWorld();
    w.script({});
    await w.port.usage();
    await w.port.danglingImageBytes();
    await w.port.prune("build-cache");
    expect(w.cli.calls.map((c) => c.timeoutMs)).toEqual([30_000, 30_000, 600_000]);
  });

  it("keeps only the last 400 characters of a failure's stderr", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "ignored", stderr: "x".repeat(1000) + "END" });
    const out = await createDocker(run).prune("build-cache");
    expect(out.ok).toBe(false);
    expect(out.detail).toHaveLength(400);
    expect(out.detail.endsWith("END")).toBe(true);
  });

  it("explains a failure that has no stderr by its error, or by 'failed'", async () => {
    expect(await createDocker(async () => ({ code: null, stdout: "", stderr: "", error: "timeout" })).prune("build-cache")).toEqual({ ok: false, detail: "timeout" });
    expect(await createDocker(async () => ({ code: 3, stdout: "", stderr: "" })).prune("build-cache")).toEqual({ ok: false, detail: "failed" });
  });

  it("keeps only the last 400 characters of a success's stdout", async () => {
    const out = await createDocker(async () => ({ code: 0, stdout: "y".repeat(900), stderr: "" })).prune("dangling-images");
    expect(out).toEqual({ ok: true, detail: "y".repeat(400) });
  });
});
