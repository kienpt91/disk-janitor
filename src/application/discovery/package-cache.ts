import { join } from "node:path";
import { CACHE_LOCATIONS } from "../../domain/discovery/catalog.js";
import { CACHE_SYMLINK_REFUSAL, HOME_MISSING_WARNING, packageCacheRule } from "../../domain/discovery/eligibility.js";
import { findSymlinkInChain, lstatOrNull } from "../inspection.js";
import type { DiscoveryRun } from "./context.js";
import { evaluateFsCandidate } from "./evaluate.js";

/** The documented default package-manager cache locations below the configured home. */
export async function scanPackageCaches(run: DiscoveryRun): Promise<void> {
  const { ports, config, findings } = run;
  const homeStat = await lstatOrNull(ports.fs, config.home);
  if (!homeStat) {
    findings.warn(HOME_MISSING_WARNING);
    return;
  }
  for (const loc of CACHE_LOCATIONS) {
    const path = join(config.home, ...loc.rel);
    const st = await lstatOrNull(ports.fs, path);
    if (!st) continue;
    const link = await findSymlinkInChain(ports.fs, path, true).catch(() => path);
    if (link) {
      findings.skip("package-cache", path, CACHE_SYMLINK_REFUSAL);
      continue;
    }
    await evaluateFsCandidate(run, { rule: packageCacheRule(loc, config.cacheMinAgeDays), path, baseDev: homeStat.dev, activityMs: 0 });
  }
}
