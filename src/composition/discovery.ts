// Composition of the discovery context: builds the adapters from Deps and exposes the Deps-based
// convenience API used by the CLI, the MCP server, the planner and the tests.

import { discoverCandidates, type DiscoveryPorts, type ScanResult } from "../application/discover.js";
import type { Config } from "../domain/model/config.js";
import { createDocker } from "../infrastructure/process/docker.js";
import { createGit } from "../infrastructure/process/git.js";
import { createLsof } from "../infrastructure/process/lsof.js";
import type { Deps } from "./deps.js";

export type { ScanResult } from "../application/discover.js";

export function discoveryPorts(deps: Deps): DiscoveryPorts {
  return {
    fs: deps.fs,
    git: createGit(deps.run, deps.fs),
    openFiles: createLsof(deps.run),
    docker: createDocker(deps.run),
    clock: { now: deps.now },
  };
}

/** Read-only discovery of reclaimable Candidates. Nothing is modified. */
export function scan(config: Config, deps: Deps): Promise<ScanResult> {
  return discoverCandidates(discoveryPorts(deps), config);
}
