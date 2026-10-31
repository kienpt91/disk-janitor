import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./domain/shared/canonical.js";
import type { Deps } from "./deps.js";
import { validateRoots } from "./roots.js";
import { arr, bool, int, literal, obj, opt, parseJson, str, type Infer } from "./domain/shared/schema.js";
import { DETECTOR_IDS, type ConfigCore, type DetectorId } from "./domain/model/types.js";

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

const MAX_CONFIG_BYTES = 64 * 1024;

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

/** Read a JSON config file (at most 64 KiB, unknown keys rejected). */
export async function loadConfigFile(path: string): Promise<RawConfig> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`config is not a regular file: ${path}`);
  if (st.size > MAX_CONFIG_BYTES) throw new Error(`config file is larger than ${MAX_CONFIG_BYTES} bytes`);
  return parseJson(await readFile(path, "utf8"), rawConfigParser, MAX_CONFIG_BYTES, "config");
}

export function parseRawConfig(text: string): RawConfig {
  return parseJson(text, rawConfigParser, MAX_CONFIG_BYTES, "config");
}

export function defaultStateDir(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg && isAbsolute(xdg)) return join(xdg, "disk-janitor");
  return join(home, ".local", "state", "disk-janitor");
}

export interface ResolveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Turn user input into a validated configuration: roots are canonicalized and checked, the
 * home directory is canonicalized, thresholds are range-checked and the digest computed.
 */
export async function resolveConfig(raw: RawConfig, deps: Deps, opts: ResolveOptions = {}): Promise<Config> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const homeInput = raw.home ? resolve(cwd, raw.home) : homedir();
  let home: string;
  try {
    home = await deps.fs.realpath(homeInput);
  } catch {
    throw new Error(`home directory does not exist: ${homeInput}`);
  }
  const homes = [...new Set([home, homedir()])];
  const roots = await validateRoots(raw.roots ?? [], { homes, fs: deps.fs, cwd });

  const detectors = new Set<DetectorId>(raw.detectors ?? DEFAULTS.detectors);
  if (raw.packageCaches) detectors.add("package-cache");
  if (raw.dockerApply) detectors.add("docker");
  const core: ConfigCore = {
    roots,
    home,
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
  const stateDir = raw.stateDir ? resolve(cwd, raw.stateDir) : defaultStateDir(home, env);
  return { ...core, stateDir, digest: configCoreDigest(core) };
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
