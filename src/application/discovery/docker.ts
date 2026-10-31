import type { DockerFinding } from "../../domain/model/candidate.js";
import {
  dockerUnavailableReport,
  dockerUnparseableReport,
  dockerUsageReports,
  offerBuildCache,
  offerDanglingImages,
} from "../../domain/discovery/eligibility.js";
import type { DiscoveryRun } from "./context.js";

/** Report docker disk usage; with dockerApply also offer build cache and dangling images for pruning. */
export async function scanDocker(run: DiscoveryRun): Promise<DockerFinding[]> {
  const { ports, config, findings } = run;
  const usage = await ports.docker.usage();
  if (usage.status === "unavailable") {
    findings.report(dockerUnavailableReport(usage.notInstalled));
    return [];
  }
  if (usage.status === "unparseable") {
    findings.report(dockerUnparseableReport(usage.message));
    return [];
  }
  for (const item of dockerUsageReports(usage.rows, config.dockerApply)) findings.report(item);
  if (!config.dockerApply) return [];
  const offers = [offerBuildCache(usage.rows, config.minSizeBytes), offerDanglingImages(await ports.docker.danglingImageBytes(), config.minSizeBytes)];
  return offers.filter((o): o is DockerFinding => o !== null);
}
