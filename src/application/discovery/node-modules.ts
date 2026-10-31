import { join } from "node:path";
import { LOCKFILES } from "../../domain/discovery/catalog.js";
import {
  nodeModulesActivityMs,
  nodeModulesPresence,
  nodeModulesRule,
  packageJsonRefusal,
  repositoryRefusal,
  selectLockfile,
  worktreeCleanRefusal,
  type FoundLockfile,
} from "../../domain/discovery/eligibility.js";
import { lstatOrNull } from "../inspection.js";
import { newestSourceMtime } from "../inspect-tree.js";
import type { DiscoveryRun } from "./context.js";
import { evaluateFsCandidate, pathKind } from "./evaluate.js";

/**
 * node_modules of a project that has package.json and a lockfile (so the install is
 * reproducible), has not been touched for `staleDays`, and whose git working tree (if any)
 * is clean.
 */
export async function evaluateNodeModules(run: DiscoveryRun, projectDir: string, root: string, rootDev: bigint): Promise<boolean> {
  const { ports, config, findings } = run;
  const nm = join(projectDir, "node_modules");
  const skip = (reason: string): false => {
    findings.skip("node-modules", nm, reason);
    return false;
  };

  const presence = nodeModulesPresence(pathKind(await lstatOrNull(ports.fs, nm)));
  if (!presence) return false;
  if (!presence.ok) return skip(presence.reason);

  const pkg = await lstatOrNull(ports.fs, join(projectDir, "package.json"));
  const noPackage = packageJsonRefusal(pkg ? { isFile: pkg.isFile(), mtimeMs: Number(pkg.mtimeMs) } : null);
  if (noPackage || !pkg) return skip(noPackage ?? "no package.json next to it, so it is not a recognised project");

  const found: FoundLockfile[] = [];
  for (const lockfile of LOCKFILES) {
    const st = await lstatOrNull(ports.fs, join(projectDir, lockfile.name));
    if (st && st.isFile()) found.push({ lockfile, mtimeMs: Number(st.mtimeMs) });
  }
  const lock = selectLockfile(found);
  if (!lock.ok) return skip(lock.reason);

  const repo = await ports.git.repoInfo(projectDir, root);
  const repoReason = repositoryRefusal(repo, root);
  if (repoReason) return skip(repoReason);
  if (repo.state === "repo") {
    const dirty = worktreeCleanRefusal(await ports.git.worktreeClean(projectDir));
    if (dirty) return skip(dirty);
  }

  const src = await newestSourceMtime(ports.fs, projectDir, rootDev, new Set(["node_modules", ".git"]), config.maxEntriesPerCandidate);
  if (!src.ok) return skip(src.reason);

  const facts = {
    projectDir,
    lockfile: lock.value,
    lockfiles: found,
    packageJsonMtimeMs: Number(pkg.mtimeMs),
    sourceNewestMs: src.newestMs,
    repoState: repo.state,
    staleDays: config.staleDays,
  };
  return evaluateFsCandidate(run, { rule: nodeModulesRule(facts), path: nm, baseDev: rootDev, activityMs: nodeModulesActivityMs(facts) });
}
