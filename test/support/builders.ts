// Pure builders for domain-level tests: configs, candidates and a seeded PRNG. No file system access.
import { buildConfig, type Config, type RawConfig } from "../../src/domain/model/config.js";
import type { DockerCandidate, FsCandidate } from "../../src/domain/model/types.js";

export const HOME = "/home/dev";
export const ROOT = "/home/dev/projects";
export const STATE_DIR = "/home/dev/.local/state/disk-janitor";

export function makeConfig(raw: RawConfig = {}, places: { roots?: string[]; home?: string; stateDir?: string } = {}): Config {
  return buildConfig(raw, { roots: places.roots ?? [ROOT], home: places.home ?? HOME, stateDir: places.stateDir ?? STATE_DIR });
}

export type FsInput = Omit<FsCandidate, "id">;
export type DockerInput = Omit<DockerCandidate, "id">;

export function fsInput(path: string, over: Partial<FsInput> = {}): FsInput {
  return {
    kind: "fs",
    detector: "node-modules",
    path,
    type: "dir",
    dev: "16777230",
    ino: "4242",
    size: 4096,
    entries: 12,
    mtimeMs: 1_700_000_000_000,
    newestMtimeMs: 1_700_000_000_000,
    ageDays: 40,
    reason: "unused dependency install",
    regenerate: "npm ci",
    ...over,
  };
}

export function dockerInput(resource: DockerInput["resource"] = "build-cache", over: Partial<DockerInput> = {}): DockerInput {
  return { kind: "docker", detector: "docker", resource, size: 1_000_000, reason: "unused build cache", regenerate: "docker rebuilds layers on demand", ...over };
}

/** Small deterministic PRNG (mulberry32) so property tests are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
