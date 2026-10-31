import { isAbsolute, join } from "node:path";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { arr, bool, int, literal, obj, opt, parseJson, str, type Infer } from "../shared/schema.js";
import { DETECTOR_IDS, type ConfigCore, type DetectorId } from "./types.js";

export const DEFAULTS = {
  detectors: ["node-modules", "build-output", "git-worktrees", "docker"] as DetectorId[],
  staleDays: 30,
  buildMinAgeDays: 7,
  cacheMinAgeDays: 7,
  minSizeBytes: 1_048_576,
  maxDepth: 8,
  maxCandidates: 500,
  maxEntriesPerCandidate: 500_000,
};

export const MAX_CONFIG_BYTES = 64 * 1024;

const rawConfigParser = obj({
  roots: opt(arr(str({ min: 1 }), { max: 64 })),
  home: opt(str({ min: 1 })),
  stateDir: opt(str({ min: 1 })),
  detectors: opt(arr(literal(...DETECTOR_IDS), { max: 16 })),
  packageCaches: opt(bool()),
  dockerApply: opt(bool()),
  staleDays: opt(int({ min: 0, max: 3650 })),
  buildMinAgeDays: opt(int({ min: 0, max: 3650 })),
  cacheMinAgeDays: opt(int({ min: 0, max: 3650 })),
  minSizeBytes: opt(int({ min: 0 })),
  maxDepth: opt(int({ min: 1, max: 16 })),
  maxCandidates: opt(int({ min: 1, max: 5000 })),
  maxEntriesPerCandidate: opt(int({ min: 1, max: 5_000_000 })),
});

export type RawConfig = Infer<typeof rawConfigParser>;

export interface Config extends ConfigCore {
  stateDir: string;
  /** SHA-256 over the canonical form of the ConfigCore. */
  digest: string;
}

export function configCoreDigest(core: ConfigCore): string {
  return sha256Hex(canonicalJson(core));
}

export function parseRawConfig(text: string): RawConfig {
  return parseJson(text, rawConfigParser, MAX_CONFIG_BYTES, "config");
}

export function defaultStateDir(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg && isAbsolute(xdg)) return join(xdg, "disk-janitor");
  return join(home, ".local", "state", "disk-janitor");
}

export interface ResolvedPlaces {
  /** Canonical, validated roots. */
  roots: string[];
  /** Canonical home directory. */
  home: string;
  /** Absolute state directory. */
  stateDir: string;
}

/** Apply defaults to user input and bind the result with a digest. Pure: places are resolved by the caller. */
export function buildConfig(raw: RawConfig, places: ResolvedPlaces): Config {
  const detectors = new Set<DetectorId>(raw.detectors ?? DEFAULTS.detectors);
  if (raw.packageCaches) detectors.add("package-cache");
  if (raw.dockerApply) detectors.add("docker");
  const core: ConfigCore = {
    roots: places.roots,
    home: places.home,
    detectors: DETECTOR_IDS.filter((d) => detectors.has(d)),
    dockerApply: raw.dockerApply ?? false,
    staleDays: raw.staleDays ?? DEFAULTS.staleDays,
    buildMinAgeDays: raw.buildMinAgeDays ?? DEFAULTS.buildMinAgeDays,
    cacheMinAgeDays: raw.cacheMinAgeDays ?? DEFAULTS.cacheMinAgeDays,
    minSizeBytes: raw.minSizeBytes ?? DEFAULTS.minSizeBytes,
    maxDepth: raw.maxDepth ?? DEFAULTS.maxDepth,
    maxCandidates: raw.maxCandidates ?? DEFAULTS.maxCandidates,
    maxEntriesPerCandidate: raw.maxEntriesPerCandidate ?? DEFAULTS.maxEntriesPerCandidate,
  };
  return { ...core, stateDir: places.stateDir, digest: configCoreDigest(core) };
}

/** Rebuild the bound core of a Config (without stateDir and digest). */
export function configCore(c: Config): ConfigCore {
  return {
    roots: c.roots,
    home: c.home,
    detectors: c.detectors,
    dockerApply: c.dockerApply,
    staleDays: c.staleDays,
    buildMinAgeDays: c.buildMinAgeDays,
    cacheMinAgeDays: c.cacheMinAgeDays,
    minSizeBytes: c.minSizeBytes,
    maxDepth: c.maxDepth,
    maxCandidates: c.maxCandidates,
    maxEntriesPerCandidate: c.maxEntriesPerCandidate,
  };
}
