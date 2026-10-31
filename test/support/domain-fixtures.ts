import type { Signer } from "../../src/domain/approval/approval.js";
import type { FsCandidate } from "../../src/domain/model/types.js";
import { sha256Hex } from "../../src/domain/shared/canonical.js";
import { Manifest, type NewManifest } from "../../src/domain/quarantine/manifest.js";

/** Deterministic stand-in for the keyed MAC: different keys give different seals. */
export function fakeSigner(key = "k1"): Signer {
  return { sign: (message) => sha256Hex(`${key}\n${message}`) };
}

export const PLAN_ID = "plan-20260101T000000Z-aaaaaaaa";
export const PLAN_DIGEST = "d".repeat(64);
export const ROOT = "/home/u/projects";
export const HOME = "/home/u";

export function candidate(i: number, overrides: Partial<FsCandidate> = {}): FsCandidate {
  return {
    kind: "fs",
    id: `c${String(i).padStart(4, "0")}`,
    detector: "node-modules",
    path: `${ROOT}/p${i}/node_modules`,
    type: "dir",
    dev: "100",
    ino: String(1000 + i),
    size: 4096 * i,
    entries: 10 * i,
    mtimeMs: 1_000 * i,
    newestMtimeMs: 2_000 * i,
    ageDays: 90,
    reason: "test",
    regenerate: "npm ci",
    ...overrides,
  };
}

export function manifestInput(count = 3, overrides: Partial<NewManifest> = {}): NewManifest {
  return {
    planId: PLAN_ID,
    planDigest: PLAN_DIGEST,
    createdAt: 5_000,
    roots: [ROOT],
    home: HOME,
    detectors: ["node-modules", "build-output"],
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
    ...overrides,
  };
}

export function newManifest(count = 3, overrides: Partial<NewManifest> = {}): Manifest {
  return Manifest.create(manifestInput(count, overrides));
}

/** mulberry32: small deterministic PRNG for property-style tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
