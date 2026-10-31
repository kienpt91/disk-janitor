import { join } from "node:path";
import { BUILD_OUTPUTS } from "../../domain/discovery/catalog.js";
import {
  GIT_IGNORED_ORIGIN,
  buildOutputRule,
  findManifest,
  ignoreRefusal,
  manifestNamesToCheck,
  manifestOrigin,
  repositoryRefusal,
  trackedFilesRefusal,
} from "../../domain/discovery/eligibility.js";
import type { RepoInfo } from "../../domain/discovery/facts.js";
import { lstatOrNull } from "../inspection.js";
import type { DiscoveryRun } from "./context.js";
import { evaluateFsCandidate } from "./evaluate.js";

async function isRealDir(run: DiscoveryRun, path: string): Promise<boolean> {
  const st = await lstatOrNull(run.ports.fs, path);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

/**
 * Build outputs and tool caches from a fixed allowlist of names. Eligible when the directory is
 * git-ignored and holds no tracked files, or (no git) the name is on the allowlist and a sibling
 * manifest identifies the project type. Returns the full paths that were accepted.
 */
export async function evaluateBuildOutputs(run: DiscoveryRun, dir: string, names: readonly string[], root: string, rootDev: bigint): Promise<string[]> {
  const { ports, config, findings } = run;
  const nameSet = new Set(names);
  const accepted: string[] = [];
  let repo: RepoInfo | undefined;
  for (const spec of BUILD_OUTPUTS) {
    if (!nameSet.has(spec.rel[0] as string)) continue;
    // every segment between the project and the output must be a real directory
    let path = dir;
    let present = true;
    for (const seg of spec.rel) {
      path = join(path, seg);
      if (!(await isRealDir(run, path))) {
        present = false;
        break;
      }
    }
    if (!present) continue;
    const skip = (reason: string): void => findings.skip("build-output", path, reason);

    repo ??= await ports.git.repoInfo(dir, root);
    const repoReason = repositoryRefusal(repo, root);
    if (repoReason) {
      skip(repoReason);
      continue;
    }
    let origin: string;
    if (repo.state === "repo") {
      const notIgnored = ignoreRefusal(await ports.git.isIgnored(dir, path));
      if (notIgnored) {
        skip(notIgnored);
        continue;
      }
      const tracked = trackedFilesRefusal(await ports.git.hasTrackedFiles(dir, path));
      if (tracked) {
        skip(tracked);
        continue;
      }
      origin = GIT_IGNORED_ORIGIN;
    } else {
      const regular: string[] = [];
      for (const n of manifestNamesToCheck(spec, names)) {
        const st = await lstatOrNull(ports.fs, join(dir, n));
        if (st && st.isFile()) regular.push(n);
      }
      const manifest = findManifest(spec, regular);
      if (!manifest.ok) {
        skip(manifest.reason);
        continue;
      }
      origin = manifestOrigin(manifest.value);
    }
    if (await evaluateFsCandidate(run, { rule: buildOutputRule(spec, origin, config.buildMinAgeDays), path, baseDev: rootDev, activityMs: 0 })) accepted.push(path);
  }
  return accepted;
}
