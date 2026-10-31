import { dirname, join } from "node:path";
import type { CommandRunner, Deps } from "./deps.js";
import { lstatOrNull } from "./application/inspection.js";

// Git is told not to prompt, not to take optional locks (status must not write the index) and not
// to run a repository-configured fsmonitor program. Repositories are untrusted input.
const GIT_PREFIX = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "/bin/false",
};

export type GitRunner = (cwd: string, args: readonly string[]) => ReturnType<CommandRunner>;

export function gitRunner(run: CommandRunner): GitRunner {
  return (cwd, args) => run("git", [...GIT_PREFIX, ...args], { cwd, env: GIT_ENV, timeoutMs: 60_000 });
}

export type RepoInfo = { state: "none" } | { state: "unavailable" } | { state: "repo"; toplevel: string };

/**
 * Is `dir` inside a git work tree? "unavailable" when git cannot be run but a .git entry exists
 * somewhere above `dir`; "none" when git says no or no .git entry exists and git is missing.
 */
export async function repoInfo(deps: Deps, dir: string, ceiling: string): Promise<RepoInfo> {
  const res = await gitRunner(deps.run)(dir, ["rev-parse", "--show-toplevel"]);
  if (res.code === 0) {
    const top = res.stdout.replace(/\n$/, "");
    try {
      return { state: "repo", toplevel: await deps.fs.realpath(top) };
    } catch {
      return { state: "unavailable" };
    }
  }
  if (res.code === null) {
    // git could not run: fall back to looking for a .git entry between dir and the root
    let cur = dir;
    for (;;) {
      if (await lstatOrNull(deps.fs, join(cur, ".git"))) return { state: "unavailable" };
      if (cur === ceiling || dirname(cur) === cur) break;
      cur = dirname(cur);
    }
    return { state: "none" };
  }
  return { state: "none" };
}

export type IgnoreState = "ignored" | "not-ignored" | "error";

/** `git check-ignore -q`: exit 0 ignored, 1 not ignored, anything else is an error. */
export async function isIgnored(deps: Deps, repoDir: string, path: string): Promise<IgnoreState> {
  const res = await gitRunner(deps.run)(repoDir, ["check-ignore", "-q", "--", path]);
  if (res.code === 0) return "ignored";
  if (res.code === 1) return "not-ignored";
  return "error";
}

/** True when git tracks at least one file at or below `path`. */
export async function hasTrackedFiles(deps: Deps, repoDir: string, path: string): Promise<boolean | "error"> {
  const res = await gitRunner(deps.run)(repoDir, ["ls-files", "-z", "--cached", "--", path]);
  if (res.code !== 0) return "error";
  return res.stdout.length > 0;
}

/** Working tree state of the pathspec `.` relative to `dir`: clean means no changes, no untracked non-ignored files. */
export async function worktreeClean(deps: Deps, dir: string): Promise<boolean | "error"> {
  const res = await gitRunner(deps.run)(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."]);
  if (res.code !== 0) return "error";
  return res.stdout.length === 0;
}
