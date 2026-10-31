import { join } from "node:path";
import type { Config } from "./config.js";
import type { Deps } from "./deps.js";
import { lstatOrNull } from "./fsapi.js";
import { loadOpenFiles } from "./openfiles.js";
import { isInside } from "./paths.js";
import { protectedReason } from "./domain/policy/protected.js";
import { BUILD_FIRST_SEGMENTS, evaluateBuildOutputs } from "./detectors/buildOutput.js";
import { skip, type ScanCtx } from "./detectors/common.js";
import { scanDocker, type DockerFinding } from "./detectors/docker.js";
import { evaluateNodeModules } from "./detectors/nodeModules.js";
import { scanPackageCaches } from "./detectors/packageCache.js";
import { reportWorktrees } from "./detectors/worktrees.js";
import type { FsCandidate, ReportItem, SkippedItem } from "./domain/model/types.js";

export const MAX_DIRS_VISITED = 100_000;

export interface ScanResult {
  fs: Array<Omit<FsCandidate, "id">>;
  docker: DockerFinding[];
  reports: ReportItem[];
  skipped: SkippedItem[];
  skippedCount: number;
  warnings: string[];
  openHandleCheck: "performed" | "unavailable";
  dirsVisited: number;
}

function enabled(config: Config, id: Config["detectors"][number]): boolean {
  return config.detectors.includes(id);
}

/**
 * Read-only discovery. Walks each root without following symlinks or crossing file systems and
 * hands every directory to the enabled detectors. Nothing is modified.
 */
export async function scan(config: Config, deps: Deps): Promise<ScanResult> {
  const homes = [...new Set([config.home])];
  const open = await loadOpenFiles(deps.run);
  const ctx: ScanCtx = { config, deps, open, homes, candidates: [], reports: [], skipped: [], skippedCount: 0, warnings: [] };
  let dirsVisited = 0;

  for (const root of config.roots) {
    const rootStat = await lstatOrNull(deps.fs, root);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      ctx.warnings.push(`root is not a real directory any more: ${root}`);
      continue;
    }
    const rootDev = rootStat.dev;
    const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const accepted = new Set<string>();
    while (stack.length > 0) {
      const { path: dir, depth } = stack.pop() as { path: string; depth: number };
      if (++dirsVisited > MAX_DIRS_VISITED) {
        ctx.warnings.push(`stopped after visiting ${MAX_DIRS_VISITED} directories; the scan is incomplete`);
        stack.length = 0;
        break;
      }
      let names: string[];
      try {
        names = await deps.fs.readdir(dir);
      } catch {
        continue;
      }
      const nameSet = new Set(names);

      if (enabled(config, "node-modules") && nameSet.has("node_modules")) {
        if (await evaluateNodeModules(ctx, dir, root, rootDev)) accepted.add(join(dir, "node_modules"));
      }
      if (enabled(config, "build-output") && names.some((n) => BUILD_FIRST_SEGMENTS.has(n))) {
        for (const p of await evaluateBuildOutputs(ctx, dir, nameSet, root, rootDev)) accepted.add(p);
      }
      if (enabled(config, "git-worktrees") && nameSet.has(".git")) {
        const g = await lstatOrNull(deps.fs, join(dir, ".git"));
        if (g && g.isDirectory() && !g.isSymbolicLink()) await reportWorktrees(ctx, dir);
      }

      if (depth >= config.maxDepth) continue;
      for (const name of names) {
        if (name === "node_modules" || name === ".git" || name.includes("\ufffd")) continue;
        const child = join(dir, name);
        if (accepted.has(child)) continue;
        let st;
        try {
          st = await deps.fs.lstat(child);
        } catch {
          continue;
        }
        if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== rootDev) continue;
        if (protectedReason(child, homes)) continue;
        stack.push({ path: child, depth: depth + 1 });
      }
    }
  }

  if (enabled(config, "package-cache")) await scanPackageCaches(ctx);
  let docker: DockerFinding[] = [];
  if (enabled(config, "docker")) docker = await scanDocker(ctx);

  // never offer a path inside another candidate
  const sorted = [...ctx.candidates].sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  const kept: typeof sorted = [];
  for (const c of sorted) {
    if (kept.some((k) => isInside(k.path, c.path))) {
      skip(ctx, c.detector, c.path, "inside another candidate");
      continue;
    }
    kept.push(c);
  }
  kept.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  let fsCandidates = kept;
  if (kept.length > config.maxCandidates) {
    ctx.warnings.push(`more than ${config.maxCandidates} candidates found; only the largest are listed`);
    fsCandidates = kept.slice(0, config.maxCandidates);
  }
  return {
    fs: fsCandidates,
    docker,
    reports: ctx.reports,
    skipped: ctx.skipped,
    skippedCount: ctx.skippedCount,
    warnings: ctx.warnings,
    openHandleCheck: open.available ? "performed" : "unavailable",
    dirsVisited,
  };
}
