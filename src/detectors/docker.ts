import type { DockerCandidate } from "../domain/model/types.js";
import type { CommandRunner } from "../infrastructure/process/command-runner.js";
import type { ScanCtx } from "./common.js";

/**
 * The only commands this tool ever sends to the docker CLI. Fixed argument lists: no volumes, no
 * running containers, no `-a`/`--all` image removal, nothing built from plan or user input.
 */
export const DOCKER_COMMANDS = {
  df: ["system", "df", "--format", "{{json .}}"],
  danglingImages: ["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"],
  pruneBuildCache: ["builder", "prune", "--force"],
  pruneDanglingImages: ["image", "prune", "--force"],
} as const;

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Parse docker's human sizes such as "1.5GB", "800MB (66%)" or "0B". Returns null when unparseable. */
export function parseDockerSize(text: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)\b/.exec(text);
  if (!m) return null;
  const unit = UNITS[(m[2] as string).toLowerCase()];
  if (unit === undefined) return null;
  const value = Number(m[1]) * unit;
  return Number.isFinite(value) ? Math.round(value) : null;
}

export interface DockerDfRow {
  type: string;
  total: number;
  active: number;
  size: number | null;
  reclaimable: number | null;
}

/** Parse `docker system df --format '{{json .}}'` output (one JSON object per line). */
export function parseDockerDf(stdout: string): DockerDfRow[] {
  const rows: DockerDfRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("unparseable docker system df output");
    }
    if (raw === null || typeof raw !== "object") throw new Error("unparseable docker system df output");
    const o = raw as Record<string, unknown>;
    const type = typeof o["Type"] === "string" ? o["Type"] : null;
    if (!type) throw new Error("unparseable docker system df output");
    rows.push({
      type,
      total: Number(o["TotalCount"] ?? 0) || 0,
      active: Number(o["Active"] ?? 0) || 0,
      size: typeof o["Size"] === "string" ? parseDockerSize(o["Size"]) : null,
      reclaimable: typeof o["Reclaimable"] === "string" ? parseDockerSize(o["Reclaimable"]) : null,
    });
  }
  return rows;
}

async function danglingImageBytes(run: CommandRunner): Promise<number | null> {
  const res = await run("docker", DOCKER_COMMANDS.danglingImages, { timeoutMs: 30_000 });
  if (res.code !== 0) return null;
  let total = 0;
  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const size = typeof o["Size"] === "string" ? parseDockerSize(o["Size"]) : null;
      if (size !== null) total += size;
    } catch {
      return null;
    }
  }
  return total;
}

/** Report docker disk usage; with dockerApply also offer build cache and dangling images for pruning. */
export async function scanDocker(ctx: ScanCtx): Promise<DockerFinding[]> {
  const { deps, config } = ctx;
  const res = await deps.run("docker", DOCKER_COMMANDS.df, { timeoutMs: 30_000 });
  if (res.code !== 0) {
    ctx.reports.push({
      detector: "docker",
      title: "docker unavailable",
      detail: res.error === "ENOENT" ? "the docker CLI was not found" : "docker system df failed (daemon not running?)",
    });
    return [];
  }
  let rows: DockerDfRow[];
  try {
    rows = parseDockerDf(res.stdout);
  } catch (e) {
    ctx.reports.push({ detector: "docker", title: "docker output not understood", detail: (e as Error).message });
    return [];
  }
  const out: DockerFinding[] = [];
  for (const r of rows) {
    ctx.reports.push({
      detector: "docker",
      title: `docker ${r.type}`,
      detail: `${r.total} total, ${r.active} active; reclaimable ${r.reclaimable ?? "unknown"} bytes (report only${config.dockerApply ? "" : "; docker apply is off"})`,
      ...(r.size !== null ? { size: r.size } : {}),
    });
  }
  if (!config.dockerApply) return [];
  const cache = rows.find((r) => r.type === "Build Cache");
  if (cache && (cache.reclaimable ?? 0) >= config.minSizeBytes) {
    out.push(
      makeDockerCandidate(
        "build-cache",
        cache.reclaimable ?? 0,
        "unused Docker build cache (docker builder prune removes only cache not in use)",
        "docker rebuilds layers on the next build",
      ),
    );
  }
  const dangling = await danglingImageBytes(deps.run);
  if (dangling !== null && dangling >= config.minSizeBytes) {
    out.push(
      makeDockerCandidate(
        "dangling-images",
        dangling,
        "dangling (untagged, unreferenced) images; docker image prune without -a removes only these. Size is an upper bound",
        "re-pull or rebuild the image if you still need it",
      ),
    );
  }
  return out;
}

export type DockerFinding = Omit<DockerCandidate, "id">;

export function makeDockerCandidate(resource: "build-cache" | "dangling-images", size: number, reason: string, regenerate: string): DockerFinding {
  return { kind: "docker" as const, detector: "docker" as const, resource, size, reason, regenerate };
}

/** Run the prune for one docker candidate with its fixed argument list. */
export async function runDockerPrune(run: CommandRunner, resource: "build-cache" | "dangling-images") {
  const args = resource === "build-cache" ? DOCKER_COMMANDS.pruneBuildCache : DOCKER_COMMANDS.pruneDanglingImages;
  return run("docker", args, { timeoutMs: 10 * 60_000 });
}
