import { dirname, join } from "node:path";
import type { FileSystem } from "../../application/ports/common.js";
import type { GitPort } from "../../application/ports/discovery.js";
import { lstatOrNull } from "../../application/inspection.js";
import { parseWorktreeList } from "../../domain/discovery/eligibility.js";
import { commandKey, parseRepositoryConfigKeys } from "../../domain/discovery/repo-config.js";
import type { CommandRunner } from "./command-runner.js";

// Repositories are untrusted input: their own config and .gitattributes can name programs git
// runs while answering status, check-ignore or ls-files (clean filters, textconv, hooks, fsmonitor).
// Every call therefore runs with:
//  - the user's global and system configuration switched off (GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM
//    point at /dev/null), system attributes off, and no global ignore file or attributes file.
//    Consequence: the user's global gitignore (core.excludesFile) is NOT consulted. A path that is
//    ignored only by it is reported as not ignored, so it is skipped: more conservative, never less.
//  - no fsmonitor, no untracked cache, no hooks and no external diff program;
//  - no prompts and no optional locks (status must not write the index).
// These command-line settings cannot override a clean filter the repository's local config defines,
// so repoInfo additionally refuses any repository whose local config defines a command at all
// (domain/discovery/repo-config) before any other question is asked of it.
export const GIT_PREFIX = [
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
] as const;
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_ASKPASS: "/bin/false",
};

/**
 * GitPort over the git CLI. Every question that could make git run a repository-defined program
 * (status, check-ignore, ls-files, worktree list) first checks the repository's local config and
 * answers "error" (null for worktrees) when it defines a command, even if the caller skipped repoInfo.
 */
export function createGit(run: CommandRunner, fs: FileSystem): GitPort {
  const git = (cwd: string, args: readonly string[]) => run("git", [...GIT_PREFIX, ...args], { cwd, env: { ...GIT_ENV }, timeoutMs: 60_000 });

  // `git config --list` only reads: it runs nothing. One call lists every scope with its origin (so
  // config.worktree is covered, which `--local` is not); includes are not followed, the include
  // directive itself is refused. Only the repository's own scopes count. The answer is remembered
  // per directory for the lifetime of the adapter.
  const verdicts = new Map<string, Promise<string | null | "unreadable">>();
  const configVerdict = (cwd: string): Promise<string | null | "unreadable"> => {
    let verdict = verdicts.get(cwd);
    if (!verdict) {
      verdict = git(cwd, ["config", "--list", "-z", "--show-scope", "--no-includes"]).then((res) =>
        res.code !== 0 ? "unreadable" : commandKey(parseRepositoryConfigKeys(res.stdout)),
      );
      verdicts.set(cwd, verdict);
    }
    return verdict;
  };

  return {
    async repoInfo(dir, ceiling) {
      const res = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (res.code === 0) {
        const top = res.stdout.replace(/\n$/, "");
        let toplevel: string;
        try {
          toplevel = await fs.realpath(top);
        } catch {
          return { state: "unavailable" };
        }
        const verdict = await configVerdict(toplevel);
        if (verdict === "unreadable") return { state: "unavailable" };
        return verdict === null ? { state: "repo", toplevel } : { state: "untrusted", key: verdict };
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
      if ((await configVerdict(repoDir)) !== null) return "error";
      const res = await git(repoDir, ["check-ignore", "-q", "--", path]);
      if (res.code === 0) return "ignored";
      if (res.code === 1) return "not-ignored";
      return "error";
    },

    async hasTrackedFiles(repoDir, path) {
      if ((await configVerdict(repoDir)) !== null) return "error";
      const res = await git(repoDir, ["ls-files", "-z", "--cached", "--", path]);
      if (res.code !== 0) return "error";
      return res.stdout.length > 0;
    },

    async worktreeClean(dir) {
      if ((await configVerdict(dir)) !== null) return "error";
      const res = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."]);
      if (res.code !== 0) return "error";
      return res.stdout.length === 0;
    },

    async worktrees(repoDir) {
      if ((await configVerdict(repoDir)) !== null) return null;
      const res = await git(repoDir, ["worktree", "list", "--porcelain", "-z"]);
      if (res.code !== 0) return null;
      return parseWorktreeList(res.stdout);
    },
  };
}
