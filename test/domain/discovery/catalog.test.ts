import { describe, expect, it } from "vitest";
import { BUILD_FIRST_SEGMENTS, BUILD_OUTPUTS, CACHE_LOCATIONS, DOCKER_COMMANDS, LOCKFILES, cachePaths } from "../../../src/domain/discovery/catalog.js";
import { protectedReason } from "../../../src/domain/policy/protected.js";

describe("catalog: build outputs", () => {
  it("every entry can be identified without git: a manifest or the Python sibling rule", () => {
    for (const spec of BUILD_OUTPUTS) expect(spec.manifests.length > 0 || spec.pySibling === true, spec.rel.join("/")).toBe(true);
  });
  it("no segment is empty, absolute, dotted-up or contains a path separator", () => {
    for (const spec of BUILD_OUTPUTS) {
      expect(spec.rel.length).toBeGreaterThan(0);
      for (const seg of spec.rel) {
        expect(seg).not.toMatch(/[\\/]/);
        expect(seg).not.toBe("");
        expect(seg).not.toBe("..");
        expect(seg).not.toBe(".");
      }
    }
  });
  it("manifests are plain file names", () => {
    for (const spec of BUILD_OUTPUTS) for (const m of spec.manifests) expect(m).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  it("every entry says how to regenerate it", () => {
    for (const spec of BUILD_OUTPUTS) expect(spec.regenerate.length).toBeGreaterThan(0);
  });
  it("no two entries are the same path, and none is nested inside another", () => {
    const joined = BUILD_OUTPUTS.map((b) => b.rel.join("/"));
    expect(new Set(joined).size).toBe(joined.length);
    for (const a of joined) for (const b of joined) if (a !== b) expect(b.startsWith(a + "/")).toBe(false);
  });
  it("first segments are derived from the entries", () => {
    expect([...BUILD_FIRST_SEGMENTS].sort()).toEqual([...new Set(BUILD_OUTPUTS.map((b) => b.rel[0]))].sort());
  });
  it("never lists a protected name", () => {
    for (const spec of BUILD_OUTPUTS) expect(protectedReason("/work/p/" + spec.rel.join("/"), [])).toBeNull();
  });
});

describe("catalog: lockfiles", () => {
  it("are unique plain names with a reinstall command", () => {
    expect(new Set(LOCKFILES.map((l) => l.name)).size).toBe(LOCKFILES.length);
    for (const l of LOCKFILES) {
      expect(l.name).not.toMatch(/[\\/]/);
      expect(l.regenerate.length).toBeGreaterThan(0);
    }
  });
});

describe("catalog: package caches", () => {
  it("ids are unique and locations are relative, separator-free segments", () => {
    expect(new Set(CACHE_LOCATIONS.map((c) => c.id)).size).toBe(CACHE_LOCATIONS.length);
    for (const c of CACHE_LOCATIONS) {
      expect(c.rel.length).toBeGreaterThanOrEqual(2);
      for (const seg of c.rel) expect(seg).not.toMatch(/[\\/]|^\.\.?$/);
    }
  });
  it("cachePaths joins every location below the home and never escapes it", () => {
    const paths = cachePaths("/home/me");
    expect(paths).toHaveLength(CACHE_LOCATIONS.length);
    for (const p of paths) expect(p.startsWith("/home/me/")).toBe(true);
    expect(paths).toContain("/home/me/.npm/_cacache");
  });
  it("is empty of anything but documented locations: no location is the home or a bare dot directory", () => {
    for (const p of cachePaths("/h")) expect(p.split("/").length).toBeGreaterThanOrEqual(4);
  });
});

describe("catalog: docker commands", () => {
  it("are exactly the four fixed argument lists", () => {
    expect(DOCKER_COMMANDS).toEqual({
      df: ["system", "df", "--format", "{{json .}}"],
      danglingImages: ["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"],
      pruneBuildCache: ["builder", "prune", "--force"],
      pruneDanglingImages: ["image", "prune", "--force"],
    });
  });
  it("never remove all images, volumes or running containers", () => {
    for (const args of Object.values(DOCKER_COMMANDS)) {
      expect(args).not.toContain("-a");
      expect(args).not.toContain("--all");
      expect(args).not.toContain("volume");
      expect(args).not.toContain("container");
      expect(args).not.toContain("system prune");
    }
  });
});
