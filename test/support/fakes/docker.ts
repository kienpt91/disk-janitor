import type { DockerCandidate } from "../../../src/domain/model/types.js";
import type { DockerPort, DockerPruneOutcome, DockerUsage } from "../../../src/application/ports/discovery.js";
import type { DockerDfRow } from "../../../src/domain/discovery/facts.js";

/** Scripted DockerPort recording the prunes it was asked to perform. */
export class FakeDocker implements DockerPort {
  usageResult: DockerUsage = { status: "unavailable", notInstalled: true };
  dangling: number | null = null;
  pruneResult: DockerPruneOutcome = { ok: true, detail: "" };
  readonly pruned: Array<DockerCandidate["resource"]> = [];

  withRows(rows: DockerDfRow[]): this {
    this.usageResult = { status: "ok", rows };
    return this;
  }
  async usage(): Promise<DockerUsage> {
    return this.usageResult;
  }
  async danglingImageBytes(): Promise<number | null> {
    return this.dangling;
  }
  async prune(resource: DockerCandidate["resource"]): Promise<DockerPruneOutcome> {
    this.pruned.push(resource);
    return this.pruneResult;
  }
}

export function dfRow(type: string, o: Partial<DockerDfRow> = {}): DockerDfRow {
  return { type, total: 1, active: 0, size: 0, reclaimable: 0, ...o };
}
