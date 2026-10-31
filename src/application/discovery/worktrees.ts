import { prunableWorktreeReports } from "../../domain/discovery/eligibility.js";
import type { DiscoveryRun } from "./context.js";

/** Report-only: list worktrees git itself marks prunable. Nothing is removed or pruned. */
export async function reportWorktrees(run: DiscoveryRun, repoDir: string): Promise<void> {
  const entries = await run.ports.git.worktrees(repoDir);
  if (!entries) return;
  for (const item of prunableWorktreeReports(repoDir, entries)) run.findings.report(item);
}
