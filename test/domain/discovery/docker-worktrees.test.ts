import { describe, expect, it } from "vitest";
import {
  DOCKER_DF_UNPARSEABLE,
  dockerUnavailableReport,
  dockerUnparseableReport,
  dockerUsageReports,
  offerBuildCache,
  offerDanglingImages,
  parseDanglingImageBytes,
  parseDockerDf,
  parseDockerSize,
  parseWorktreeList,
  prunableWorktreeReports,
} from "../../../src/domain/discovery/eligibility.js";
import type { DockerDfRow } from "../../../src/domain/discovery/facts.js";

const row = (type: string, o: Partial<DockerDfRow> = {}): DockerDfRow => ({ type, total: 2, active: 1, size: 1000, reclaimable: 500, ...o });

describe("parseDockerSize", () => {
  it.each([
    ["0B", 0],
    ["1.5GB", 1.5e9],
    ["800MB (66%)", 800e6],
    ["12kB", 12_000],
    ["1KiB", 1024],
    ["2GiB", 2 * 1024 ** 3],
    ["1 TB", 1e12],
    ["  3MB", 3e6],
    ["1.0MiB", 1024 ** 2],
  ])("parses %s", (text, bytes) => {
    expect(parseDockerSize(text)).toBe(bytes);
  });
  it.each(["", "garbage", "12", "12 parsecs", "-5MB", "MB", "NaNGB", "1e3MB"])("returns null for %j", (text) => {
    expect(parseDockerSize(text)).toBeNull();
  });
});

describe("parseDockerDf", () => {
  it("parses one object per line and ignores blank lines", () => {
    const out = [
      JSON.stringify({ Type: "Images", TotalCount: 3, Active: 1, Size: "1GB", Reclaimable: "500MB (50%)" }),
      "",
      JSON.stringify({ Type: "Build Cache", TotalCount: "4", Active: "0", Size: "200MB", Reclaimable: "200MB" }),
      "  ",
    ].join("\n");
    expect(parseDockerDf(out)).toEqual([
      { type: "Images", total: 3, active: 1, size: 1e9, reclaimable: 500e6 },
      { type: "Build Cache", total: 4, active: 0, size: 200e6, reclaimable: 200e6 },
    ]);
  });
  it("tolerates missing or non-string sizes and counts", () => {
    expect(parseDockerDf('{"Type":"Volumes","TotalCount":"x","Size":5}')).toEqual([{ type: "Volumes", total: 0, active: 0, size: null, reclaimable: null }]);
  });
  it("accepts empty output", () => {
    expect(parseDockerDf("")).toEqual([]);
  });
  it.each(["not json", "[1,2]x", "null", "42", '"s"', '{"TotalCount":1}', '{"Type":7}', '{"Type":""}'])("throws on garbage %j", (line) => {
    expect(() => parseDockerDf(line)).toThrow(DOCKER_DF_UNPARSEABLE);
  });
  it("one bad line spoils the whole output", () => {
    expect(() => parseDockerDf('{"Type":"Images"}\noops')).toThrow(DOCKER_DF_UNPARSEABLE);
  });
});

describe("parseDanglingImageBytes", () => {
  it("sums the sizes of dangling images", () => {
    expect(parseDanglingImageBytes('{"Size":"1MB"}\n{"Size":"2.5MB"}\n')).toBe(3_500_000);
  });
  it("is zero for no images and ignores entries without a parseable size", () => {
    expect(parseDanglingImageBytes("")).toBe(0);
    expect(parseDanglingImageBytes('{"Size":"huge"}\n{"ID":"x"}')).toBe(0);
  });
  it("is null when a line is not JSON", () => {
    expect(parseDanglingImageBytes('{"Size":"1MB"}\nbroken')).toBeNull();
  });
});

describe("docker reports and offers", () => {
  it("reports one line per resource type, with the apply note", () => {
    const off = dockerUsageReports([row("Images"), row("Containers", { size: null, reclaimable: null })], false);
    expect(off).toEqual([
      { detector: "docker", title: "docker Images", detail: "2 total, 1 active; reclaimable 500 bytes (report only; docker apply is off)", size: 1000 },
      { detector: "docker", title: "docker Containers", detail: "2 total, 1 active; reclaimable unknown bytes (report only; docker apply is off)" },
    ]);
    expect(dockerUsageReports([row("Images")], true)[0]?.detail).toBe("2 total, 1 active; reclaimable 500 bytes (report only)");
  });
  it("explains why docker is unavailable or not understood", () => {
    expect(dockerUnavailableReport(true).detail).toBe("the docker CLI was not found");
    expect(dockerUnavailableReport(false).detail).toBe("docker system df failed (daemon not running?)");
    expect(dockerUnparseableReport("m")).toEqual({ detector: "docker", title: "docker output not understood", detail: "m" });
  });
  it("offers the build cache at or above the minimum, using its reclaimable size", () => {
    const offer = offerBuildCache([row("Images"), row("Build Cache", { reclaimable: 700 })], 700);
    expect(offer).toMatchObject({ kind: "docker", resource: "build-cache", size: 700 });
    expect(offerBuildCache([row("Build Cache", { reclaimable: 699 })], 700)).toBeNull();
  });
  it("offers nothing without a build cache row or with an unknown reclaimable size", () => {
    expect(offerBuildCache([row("Images")], 0)).toBeNull();
    expect(offerBuildCache([row("Build Cache", { reclaimable: null })], 1)).toBeNull();
    expect(offerBuildCache([row("Build Cache", { reclaimable: null })], 0)?.size).toBe(0);
  });
  it("offers dangling images only when measured and large enough", () => {
    expect(offerDanglingImages(null, 0)).toBeNull();
    expect(offerDanglingImages(99, 100)).toBeNull();
    expect(offerDanglingImages(100, 100)).toMatchObject({ resource: "dangling-images", size: 100 });
    expect(offerDanglingImages(100, 100)?.reason).toContain("upper bound");
  });
});

describe("parseWorktreeList", () => {
  const nul = (...fields: string[]) => fields.join("\0") + "\0";
  it("parses records separated by empty fields", () => {
    const out = nul("worktree /r", "HEAD abc", "branch refs/heads/main", "") + nul("worktree /w", "HEAD def", "detached", "prunable gitdir file points to non-existent location", "");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/r", prunable: null },
      { path: "/w", prunable: "gitdir file points to non-existent location" },
    ]);
  });
  it("a bare prunable field gets a default reason", () => {
    expect(parseWorktreeList(nul("worktree /w", "prunable", ""))).toEqual([{ path: "/w", prunable: "prunable" }]);
  });
  it("handles a final record without a terminator and paths with spaces and newlines", () => {
    expect(parseWorktreeList("worktree /a b\nc\0prunable x")).toEqual([{ path: "/a b\nc", prunable: "x" }]);
  });
  it("starts a new record at the next worktree field even without a blank separator", () => {
    expect(parseWorktreeList(nul("worktree /a", "worktree /b"))).toEqual([
      { path: "/a", prunable: null },
      { path: "/b", prunable: null },
    ]);
  });
  it("ignores fields outside a record, empty and garbage input", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList(nul("prunable x", "HEAD abc", "junk"))).toEqual([]);
    expect(parseWorktreeList("\0\0\0")).toEqual([]);
  });
  it("does not mistake prunable-looking prefixes for the field", () => {
    expect(parseWorktreeList(nul("worktree /a", "prunablex"))).toEqual([{ path: "/a", prunable: null }]);
  });
});

describe("prunableWorktreeReports", () => {
  it("reports only prunable worktrees, with advice and never an action", () => {
    const r = prunableWorktreeReports("/r", [
      { path: "/r", prunable: null },
      { path: "/gone", prunable: "gitdir missing" },
    ]);
    expect(r).toEqual([
      {
        detector: "git-worktrees",
        title: "prunable git worktree",
        detail: "repository /r: gitdir missing. Review, then run 'git worktree prune' yourself; disk-janitor never removes worktrees",
        path: "/gone",
      },
    ]);
    expect(prunableWorktreeReports("/r", [])).toEqual([]);
  });
});
