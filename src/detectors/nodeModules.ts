import { join } from "node:path";
import { newestSourceMtime } from "../analyze.js";
import { lstatOrNull } from "../fsapi.js";
import { repoInfo, worktreeClean } from "../git.js";
import { isInside } from "../paths.js";
import { evaluateFsCandidate, skip, type ScanCtx } from "./common.js";

const LOCKFILES: Array<[string, string]> = [
  ["package-lock.json", "npm ci"],
  ["npm-shrinkwrap.json", "npm ci"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
];

/**
 * node_modules of a project that has package.json and a lockfile (so the install is
 * reproducible), has not been touched for `staleDays`, and whose git working tree (if any)
 * is clean.
 */
export async function evaluateNodeModules(ctx: ScanCtx, projectDir: string, root: string, rootDev: bigint): Promise<boolean> {
  const { deps, config } = ctx;
  const nm = join(projectDir, "node_modules");
  const nmStat = await lstatOrNull(deps.fs, nm);
  if (!nmStat) return false;
  if (nmStat.isSymbolicLink()) {
    skip(ctx, "node-modules", nm, "node_modules is a symlink (never followed)");
    return false;
  }
  if (!nmStat.isDirectory()) return false;

  const pkg = await lstatOrNull(deps.fs, join(projectDir, "package.json"));
  if (!pkg || !pkg.isFile()) {
    skip(ctx, "node-modules", nm, "no package.json next to it, so it is not a recognised project");
    return false;
  }
  const lockStats: Array<{ name: string; mtimeMs: number; hint: string }> = [];
  for (const [name, hint] of LOCKFILES) {
    const st = await lstatOrNull(deps.fs, join(projectDir, name));
    if (st && st.isFile()) lockStats.push({ name, mtimeMs: Number(st.mtimeMs), hint });
  }
  const lock = lockStats[0];
  if (!lock) {
    skip(ctx, "node-modules", nm, "no lockfile, so a reinstall would not be reproducible");
    return false;
  }

  const repo = await repoInfo(deps, projectDir, root);
  if (repo.state === "unavailable") {
    skip(ctx, "node-modules", nm, "inside a git repository but git state could not be read");
    return false;
  }
  let gitNote = "no git repository";
  if (repo.state === "repo") {
    if (!isInside(root, repo.toplevel)) {
      skip(ctx, "node-modules", nm, "its git repository root is outside the configured root");
      return false;
    }
    const clean = await worktreeClean(deps, projectDir);
    if (clean === "error") {
      skip(ctx, "node-modules", nm, "git status failed");
      return false;
    }
    if (!clean) {
      skip(ctx, "node-modules", nm, "git working tree has uncommitted or untracked changes");
      return false;
    }
    gitNote = "git working tree clean";
  }

  const src = await newestSourceMtime(deps.fs, projectDir, rootDev, new Set(["node_modules", ".git"]), config.maxEntriesPerCandidate);
  if (!src.ok) {
    skip(ctx, "node-modules", nm, src.reason);
    return false;
  }
  const activityMs = Math.max(src.newestMs, Number(pkg.mtimeMs), ...lockStats.map((l) => l.mtimeMs));

  return evaluateFsCandidate(ctx, {
    detector: "node-modules",
    path: nm,
    baseDev: rootDev,
    strict: false,
    activityMs,
    minAgeDays: config.staleDays,
    reasonFor: (age) => `project untouched for ${age} days; package.json and ${lock.name} present; ${gitNote}`,
    regenerate: `${lock.hint} (in ${projectDir})`,
  });
}
