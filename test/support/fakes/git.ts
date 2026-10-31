import { dirname, join } from "node:path";
import type { FileSystem } from "../../../src/application/ports/common.js";
import type { GitPort } from "../../../src/application/ports/discovery.js";
import type { IgnoreState, RepoInfo, WorktreeEntry } from "../../../src/domain/discovery/facts.js";
import { isInside } from "../../../src/domain/shared/paths.js";

export type GitFailure = "check-ignore" | "ls-files" | "status" | "worktree";

/**
 * In-memory GitPort. Repositories, tracked files, ignore patterns (a name that matches any path
 * component below the repository) and modified files are declared by the test; the working-tree
 * state is derived from the fake file system the way `git status` would see it: a file that is
 * neither tracked nor ignored is untracked, a declared modification is a change.
 */
export class FakeGit implements GitPort {
  readonly repos = new Set<string>();
  private readonly ignorePatterns = new Map<string, Set<string>>();
  private readonly trackedFiles = new Set<string>();
  private readonly modified = new Set<string>();
  private readonly linked = new Map<string, WorktreeEntry[]>();
  private readonly failing = new Set<GitFailure>();
  /** When true the git executable is "missing": only a .git-like marker above the directory is known. */
  gitMissing = false;
  readonly calls: string[] = [];

  constructor(private readonly fs: FileSystem) {}

  initRepo(dir: string): this {
    this.repos.add(dir);
    return this;
  }
  ignore(repo: string, name: string): this {
    const set = this.ignorePatterns.get(repo) ?? new Set<string>();
    set.add(name);
    this.ignorePatterns.set(repo, set);
    return this;
  }
  track(path: string): this {
    this.trackedFiles.add(path);
    return this;
  }
  modify(path: string): this {
    this.modified.add(path);
    return this;
  }
  addWorktree(repo: string, entry: WorktreeEntry): this {
    this.linked.set(repo, [...(this.linked.get(repo) ?? []), entry]);
    return this;
  }
  fail(op: GitFailure): this {
    this.failing.add(op);
    return this;
  }

  private repoOf(path: string): string | null {
    let cur = path;
    for (;;) {
      if (this.repos.has(cur)) return cur;
      const up = dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }

  private ignoredIn(repo: string, path: string): boolean {
    const patterns = this.ignorePatterns.get(repo);
    if (!patterns || !isInside(repo, path) || path === repo) return false;
    return path
      .slice(repo.length + 1)
      .split("/")
      .some((seg) => patterns.has(seg));
  }

  async repoInfo(dir: string, ceiling: string): Promise<RepoInfo> {
    this.calls.push(`repoInfo ${dir}`);
    const top = this.repoOf(dir);
    if (this.gitMissing) {
      for (let cur = dir; ; cur = dirname(cur)) {
        if (this.repos.has(cur)) return { state: "unavailable" };
        if (cur === ceiling || dirname(cur) === cur) return { state: "none" };
      }
    }
    if (!top) return { state: "none" };
    return { state: "repo", toplevel: await this.fs.realpath(top) };
  }

  async isIgnored(repoDir: string, path: string): Promise<IgnoreState> {
    this.calls.push(`isIgnored ${path}`);
    if (this.failing.has("check-ignore")) return "error";
    const repo = this.repoOf(repoDir);
    if (!repo) return "error";
    return this.ignoredIn(repo, path) ? "ignored" : "not-ignored";
  }

  async hasTrackedFiles(_repoDir: string, path: string): Promise<boolean | "error"> {
    this.calls.push(`hasTrackedFiles ${path}`);
    if (this.failing.has("ls-files") || !this.repoOf(path)) return "error";
    return [...this.trackedFiles].some((f) => isInside(path, f));
  }

  async worktreeClean(dir: string): Promise<boolean | "error"> {
    this.calls.push(`worktreeClean ${dir}`);
    if (this.failing.has("status")) return "error";
    const repo = this.repoOf(dir);
    if (!repo) return "error";
    if ([...this.modified].some((f) => isInside(dir, f))) return false;
    return !(await this.hasUntracked(repo, dir));
  }

  private async hasUntracked(repo: string, dir: string): Promise<boolean> {
    for (const name of await this.fs.readdir(dir)) {
      const p = join(dir, name);
      if (name === ".git" || this.ignoredIn(repo, p)) continue;
      const st = await this.fs.lstat(p);
      if (st.isDirectory()) {
        if (await this.hasUntracked(repo, p)) return true;
      } else if (!this.trackedFiles.has(p)) return true;
    }
    return false;
  }

  async worktrees(repoDir: string): Promise<WorktreeEntry[] | null> {
    this.calls.push(`worktrees ${repoDir}`);
    const top = this.repoOf(repoDir);
    if (this.failing.has("worktree") || !top) return null;
    return [{ path: top, prunable: null }, ...(this.linked.get(top) ?? [])];
  }
}
