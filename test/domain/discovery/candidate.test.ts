import { describe, expect, it } from "vitest";
import { CandidateInvariantError, newDockerFinding, newFsFinding, type FsFindingInput } from "../../../src/domain/model/candidate.js";

const OK: FsFindingInput = {
  detector: "build-output",
  path: "/work/app/dist",
  dev: 66n,
  ino: 12345678901234567890n,
  size: 4096,
  entries: 3,
  mtimeMs: 10,
  newestMtimeMs: 20,
  ageDays: 0,
  reason: "why",
  regenerate: "how",
};

describe("newFsFinding", () => {
  it("builds a plain candidate with decimal device and inode strings (inodes exceed 2^53)", () => {
    expect(newFsFinding(OK)).toEqual({
      kind: "fs",
      detector: "build-output",
      path: "/work/app/dist",
      type: "dir",
      dev: "66",
      ino: "12345678901234567890",
      size: 4096,
      entries: 3,
      mtimeMs: 10,
      newestMtimeMs: 20,
      ageDays: 0,
      reason: "why",
      regenerate: "how",
    });
  });

  it.each([
    ["relative path", { path: "app/dist" }],
    ["non-normalized path", { path: "/work/app/../dist" }],
    ["trailing separator", { path: "/work/app/dist/" }],
    ["NUL in path", { path: "/work/a\0b" }],
    ["negative size", { size: -1 }],
    ["fractional size", { size: 1.5 }],
    ["NaN size", { size: Number.NaN }],
    ["negative entries", { entries: -1 }],
    ["negative age", { ageDays: -1 }],
    ["fractional age", { ageDays: 0.5 }],
    ["negative device", { dev: -1n }],
    ["negative inode", { ino: -1n }],
    ["non-finite mtime", { mtimeMs: Number.POSITIVE_INFINITY }],
    ["empty reason", { reason: "" }],
    ["empty regenerate", { regenerate: "" }],
    ["docker detector", { detector: "docker" as const }],
  ] as Array<[string, Partial<FsFindingInput>]>)("rejects %s", (_name, patch) => {
    expect(() => newFsFinding({ ...OK, ...patch })).toThrow(CandidateInvariantError);
  });
});

describe("newDockerFinding", () => {
  it("builds a docker candidate", () => {
    expect(newDockerFinding("build-cache", 10, "r", "g")).toEqual({ kind: "docker", detector: "docker", resource: "build-cache", size: 10, reason: "r", regenerate: "g" });
  });
  it.each([
    ["negative size", -5, "r", "g"],
    ["non-integer size", 0.1, "r", "g"],
    ["empty reason", 1, "", "g"],
    ["empty regenerate", 1, "r", ""],
  ] as const)("rejects %s", (_n, size, reason, regen) => {
    expect(() => newDockerFinding("dangling-images", size, reason, regen)).toThrow(CandidateInvariantError);
  });
});
