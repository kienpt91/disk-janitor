// Validated construction of Candidates. A Candidate that exists satisfies the invariants the plan
// and apply rely on: canonical absolute path, non-negative whole sizes and ages, decimal ids.

import { isCanonicalAbsolute } from "../shared/paths.js";
import type { DetectorId, DockerCandidate, FsCandidate } from "./types.js";

/** A Candidate before the plan assigns it an id. */
export type FsFinding = Omit<FsCandidate, "id">;
export type DockerFinding = Omit<DockerCandidate, "id">;

export class CandidateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateInvariantError";
  }
}

function wholeNumber(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CandidateInvariantError(`${what} must be a non-negative whole number`);
}

function text(value: string, what: string): void {
  if (typeof value !== "string" || value.length === 0) throw new CandidateInvariantError(`${what} must not be empty`);
}

export interface FsFindingInput {
  detector: DetectorId;
  path: string;
  dev: bigint;
  ino: bigint;
  size: number;
  entries: number;
  mtimeMs: number;
  newestMtimeMs: number;
  ageDays: number;
  reason: string;
  regenerate: string;
}

export function newFsFinding(input: FsFindingInput): FsFinding {
  if (!isCanonicalAbsolute(input.path)) throw new CandidateInvariantError("candidate path must be a canonical absolute path");
  if (input.detector === "docker") throw new CandidateInvariantError("the docker detector offers docker candidates only");
  if (input.dev < 0n || input.ino < 0n) throw new CandidateInvariantError("device and inode numbers must not be negative");
  wholeNumber(input.size, "size");
  wholeNumber(input.entries, "entries");
  wholeNumber(input.ageDays, "ageDays");
  if (!Number.isFinite(input.mtimeMs) || !Number.isFinite(input.newestMtimeMs)) throw new CandidateInvariantError("times must be finite");
  text(input.reason, "reason");
  text(input.regenerate, "regenerate");
  return {
    kind: "fs",
    detector: input.detector,
    path: input.path,
    type: "dir",
    dev: input.dev.toString(),
    ino: input.ino.toString(),
    size: input.size,
    entries: input.entries,
    mtimeMs: input.mtimeMs,
    newestMtimeMs: input.newestMtimeMs,
    ageDays: input.ageDays,
    reason: input.reason,
    regenerate: input.regenerate,
  };
}

export function newDockerFinding(resource: DockerCandidate["resource"], size: number, reason: string, regenerate: string): DockerFinding {
  wholeNumber(size, "size");
  text(reason, "reason");
  text(regenerate, "regenerate");
  return { kind: "docker", detector: "docker", resource, size, reason, regenerate };
}
