import { join } from "node:path";
import { BUILD_FIRST_SEGMENTS } from "../domain/discovery/catalog.js";
import { Findings } from "../domain/discovery/findings.js";
import type { Config } from "../domain/model/config.js";
import type { DockerFinding, FsFinding } from "../domain/model/candidate.js";
import type { ReportItem, SkippedItem } from "../domain/model/types.js";
import { protectedReason } from "../domain/policy/protected.js";
import { evaluateBuildOutputs } from "./discovery/build-output.js";
import type { DiscoveryPorts, DiscoveryRun } from "./discovery/context.js";
import { scanDocker } from "./discovery/docker.js";
import { evaluateNodeModules } from "./discovery/node-modules.js";
import { scanPackageCaches } from "./discovery/package-cache.js";
import { reportWorktrees } from "./discovery/worktrees.js";
import { lstatOrNull } from "./inspection.js";

export type { DiscoveryPorts } from "./discovery/context.js";

export const MAX_DIRS_VISITED = 100_000;

export interface ScanResult {
  fs: FsFinding[];
  docker: DockerFinding[];
  reports: ReportItem[];
  skipped: SkippedItem[];
  skippedCount: number;
  warnings: string[];
  openHandleCheck: "performed" | "unavailable";
  dirsVisited: number;
}

const enabled = (config: Config, id: Config["detectors"][number]): boolean => config.detectors.includes(id);

/**
 * DiscoverCandidates: read-only discovery. Walks each Root without following symlinks or
 * crossing file systems and hands every directory to the enabled Detectors. Nothing is modified.
 */
export async function discoverCandidates(ports: DiscoveryPorts, config: Config): Promise<ScanResult> {
  const findings = new Findings();
  const run: DiscoveryRun = { ports, config, open: await ports.openFiles.snapshot(), homes: [...new Set([config.home])], findings };
  let dirsVisited = 0;

  for (const root of config.roots) {
    const rootStat = await lstatOrNull(ports.fs, root);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      findings.warn(`root is not a real directory any more: ${root}`);
      continue;
    }
    const rootDev = rootStat.dev;
    const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const accepted = new Set<string>();
    while (stack.length > 0) {
      const { path: dir, depth } = stack.pop() as { path: string; depth: number };
      if (++dirsVisited > MAX_DIRS_VISITED) {
        findings.warn(`stopped after visiting ${MAX_DIRS_VISITED} directories; the scan is incomplete`);
        stack.length = 0;
        break;
      }
      let names: string[];
      try {
        names = await ports.fs.readdir(dir);
      } catch {
        continue;
      }

      if (enabled(config, "node-modules") && names.includes("node_modules")) {
        if (await evaluateNodeModules(run, dir, root, rootDev)) accepted.add(join(dir, "node_modules"));
      }
      if (enabled(config, "build-output") && names.some((n) => BUILD_FIRST_SEGMENTS.has(n))) {
        for (const p of await evaluateBuildOutputs(run, dir, names, root, rootDev)) accepted.add(p);
      }
      if (enabled(config, "git-worktrees") && names.includes(".git")) {
        const g = await lstatOrNull(ports.fs, join(dir, ".git"));
        if (g && g.isDirectory() && !g.isSymbolicLink()) await reportWorktrees(run, dir);
      }

      if (depth >= config.maxDepth) continue;
      for (const name of names) {
        if (name === "node_modules" || name === ".git" || name.includes("\ufffd")) continue;
        const child = join(dir, name);
        if (accepted.has(child)) continue;
        let st;
        try {
          st = await ports.fs.lstat(child);
        } catch {
          continue;
        }
        if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== rootDev) continue;
        if (protectedReason(child, run.homes)) continue;
        stack.push({ path: child, depth: depth + 1 });
      }
    }
  }

  if (enabled(config, "package-cache")) await scanPackageCaches(run);
  const docker = enabled(config, "docker") ? await scanDocker(run) : [];
  const summary = findings.close(config.maxCandidates);
  return {
    ...summary,
    docker,
    openHandleCheck: run.open.available ? "performed" : "unavailable",
    dirsVisited,
  };
}
