import { dirname, join } from "node:path";
import type { FileSystem } from "../../application/ports/common.js";
import type { GitPort } from "../../application/ports/discovery.js";
import { lstatOrNull } from "../../application/inspection.js";
import { parseWorktreeList } from "../../domain/discovery/eligibility.js";
import type { CommandRunner } from "./command-runner.js";

// Git is told not to prompt, not to take optional locks (status must not write the index) and not
// to run a repository-configured fsmonitor program. Repositories are untrusted input.
export const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"] as const;
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "/bin/false",
};

/** GitPort over the git CLI. */
export function createGit(run: CommandRunner, fs: FileSystem): GitPort {
  const git = (cwd: string, args: readonly string[]) => run("git", [...GIT_PREFIX, ...args], { cwd, env: { ...GIT_ENV }, timeoutMs: 60_000 });

  return {
    async repoInfo(dir, ceiling) {
      const res = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (res.code === 0) {
        const top = res.stdout.replace(/\n$/, "");
        try {
          return { state: "repo", toplevel: await fs.realpath(top) };
        } catch {
          return { state: "unavailable" };
        }
      }
      if (res.code === null) {
        // git could not run: fall back to looking for a .git entry between dir and the root
        let cur = dir;
        for (;;) {
          if (await lstatOrNull(fs, join(cur, ".git"))) return { state: "unavailable" };
          if (cur === ceiling || dirname(cur) === cur) break;
          cur = dirname(cur);
        }
      }
      return { state: "none" };
    },

    /** `git check-ignore -q`: exit 0 ignored, 1 not ignored, anything else is an error. */
    async isIgnored(repoDir, path) {
      const res = await git(repoDir, ["check-ignore", "-q", "--", path]);
      if (res.code === 0) return "ignored";
      if (res.code === 1) return "not-ignored";
      return "error";
    },

    async hasTrackedFiles(repoDir, path) {
      const res = await git(repoDir, ["ls-files", "-z", "--cached", "--", path]);
      if (res.code !== 0) return "error";
      return res.stdout.length > 0;
    },

    async worktreeClean(dir) {
      const res = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."]);
      if (res.code !== 0) return "error";
      return res.stdout.length === 0;
    },

    async worktrees(repoDir) {
      const res = await git(repoDir, ["worktree", "list", "--porcelain", "-z"]);
      if (res.code !== 0) return null;
      return parseWorktreeList(res.stdout);
    },
  };
}
