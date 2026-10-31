import { gitRunner } from "../git.js";
import type { ScanCtx } from "./common.js";

export interface WorktreeEntry {
  path: string;
  prunable: string | null;
}

/** Parse `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends a record. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (cur) out.push(cur);
      cur = null;
    } else if (field.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: field.slice("worktree ".length), prunable: null };
    } else if (cur && (field === "prunable" || field.startsWith("prunable "))) {
      cur.prunable = field.slice("prunable".length).trim() || "prunable";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Report-only: list worktrees git itself marks prunable (their directory is gone). This tool never
 * removes or prunes worktrees; the report tells the user which command to run themselves.
 */
export async function reportWorktrees(ctx: ScanCtx, repoDir: string): Promise<void> {
  const res = await gitRunner(ctx.deps.run)(repoDir, ["worktree", "list", "--porcelain", "-z"]);
  if (res.code !== 0) return;
  for (const wt of parseWorktreeList(res.stdout)) {
    if (wt.prunable === null) continue;
    ctx.reports.push({
      detector: "git-worktrees",
      title: "prunable git worktree",
      detail: `repository ${repoDir}: ${wt.prunable}. Review, then run 'git worktree prune' yourself; disk-janitor never removes worktrees`,
      path: wt.path,
    });
  }
}
