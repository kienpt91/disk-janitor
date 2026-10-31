import { describe, expect, it } from "vitest";
import { buildConfig, configCore, configCoreDigest, DEFAULTS, defaultStateDir, MAX_CONFIG_BYTES, parseRawConfig, type RawConfig } from "../../src/domain/model/config.js";
import { SchemaError } from "../../src/domain/shared/schema.js";
import { canonicalJson, sha256Hex } from "../../src/domain/shared/canonical.js";
import { DETECTOR_IDS } from "../../src/domain/model/types.js";
import { HOME, makeConfig, ROOT, STATE_DIR } from "../support/builders.js";

describe("buildConfig", () => {
  it("applies the documented defaults", () => {
    const c = makeConfig();
    expect(c).toMatchObject({
      roots: [ROOT],
      home: HOME,
      stateDir: STATE_DIR,
      detectors: ["node-modules", "build-output", "docker", "git-worktrees"],
      dockerApply: false,
      staleDays: 30,
      buildMinAgeDays: 7,
      cacheMinAgeDays: 7,
      minSizeBytes: 1_048_576,
      maxDepth: 8,
      maxCandidates: 500,
      maxEntriesPerCandidate: 500_000,
    });
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("DEFAULTS match what buildConfig applies", () => {
    const c = makeConfig();
    expect(c.staleDays).toBe(DEFAULTS.staleDays);
    expect(c.buildMinAgeDays).toBe(DEFAULTS.buildMinAgeDays);
    expect(c.cacheMinAgeDays).toBe(DEFAULTS.cacheMinAgeDays);
    expect(c.minSizeBytes).toBe(DEFAULTS.minSizeBytes);
    expect(c.maxDepth).toBe(DEFAULTS.maxDepth);
    expect(c.maxCandidates).toBe(DEFAULTS.maxCandidates);
    expect(c.maxEntriesPerCandidate).toBe(DEFAULTS.maxEntriesPerCandidate);
  });

  it("overrides every threshold", () => {
    const c = makeConfig({ staleDays: 1, buildMinAgeDays: 2, cacheMinAgeDays: 3, minSizeBytes: 4, maxDepth: 5, maxCandidates: 6, maxEntriesPerCandidate: 7 });
    expect([c.staleDays, c.buildMinAgeDays, c.cacheMinAgeDays, c.minSizeBytes, c.maxDepth, c.maxCandidates, c.maxEntriesPerCandidate]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps explicit zeros instead of falling back to defaults", () => {
    const c = makeConfig({ staleDays: 0, minSizeBytes: 0, buildMinAgeDays: 0, cacheMinAgeDays: 0 });
    expect([c.staleDays, c.minSizeBytes, c.buildMinAgeDays, c.cacheMinAgeDays]).toEqual([0, 0, 0, 0]);
  });

  it("uses the resolved places verbatim", () => {
    const c = makeConfig({}, { roots: ["/r/a", "/r/b"], home: "/h", stateDir: "/s" });
    expect([c.roots, c.home, c.stateDir]).toEqual([["/r/a", "/r/b"], "/h", "/s"]);
  });

  it("an explicit detector list replaces the defaults", () => {
    expect(makeConfig({ detectors: ["node-modules"] }).detectors).toEqual(["node-modules"]);
    expect(makeConfig({ detectors: [] }).detectors).toEqual([]);
  });

  it("orders detectors canonically and drops duplicates", () => {
    const c = makeConfig({ detectors: ["git-worktrees", "node-modules", "git-worktrees", "build-output"] });
    expect(c.detectors).toEqual(["node-modules", "build-output", "git-worktrees"]);
  });

  it("packageCaches adds the package-cache detector", () => {
    expect(makeConfig({ packageCaches: true }).detectors).toContain("package-cache");
    expect(makeConfig({ packageCaches: false }).detectors).not.toContain("package-cache");
  });

  it("dockerApply sets the flag and enables the docker detector even when it was left out", () => {
    const c = makeConfig({ dockerApply: true, detectors: ["node-modules"] });
    expect(c.dockerApply).toBe(true);
    expect(c.detectors).toEqual(["node-modules", "docker"]);
  });

  it("detector ids in the result are always a canonically ordered subset", () => {
    const c = makeConfig({ detectors: [...DETECTOR_IDS].reverse(), packageCaches: true, dockerApply: true });
    expect(c.detectors).toEqual([...DETECTOR_IDS]);
  });

  describe("digest", () => {
    it("is the SHA-256 of the canonical core and excludes stateDir", () => {
      const c = makeConfig();
      expect(c.digest).toBe(sha256Hex(canonicalJson(configCore(c))));
      expect(c.digest).toBe(configCoreDigest(configCore(c)));
      expect(configCore(c)).not.toHaveProperty("stateDir");
      expect(configCore(c)).not.toHaveProperty("digest");
    });

    it("is stable for identical input", () => {
      expect(makeConfig({ staleDays: 3 }).digest).toBe(makeConfig({ staleDays: 3 }).digest);
    });

    it("does not change with the state directory", () => {
      expect(makeConfig({}, { stateDir: "/elsewhere" }).digest).toBe(makeConfig().digest);
    });

    const variants: Array<[string, RawConfig, { roots?: string[]; home?: string }]> = [
      ["roots", {}, { roots: ["/home/dev/other"] }],
      ["home", {}, { home: "/home/other" }],
      ["detectors", { detectors: ["node-modules"] }, {}],
      ["dockerApply", { dockerApply: true }, {}],
      ["staleDays", { staleDays: 31 }, {}],
      ["buildMinAgeDays", { buildMinAgeDays: 8 }, {}],
      ["cacheMinAgeDays", { cacheMinAgeDays: 8 }, {}],
      ["minSizeBytes", { minSizeBytes: 1 }, {}],
      ["maxDepth", { maxDepth: 9 }, {}],
      ["maxCandidates", { maxCandidates: 501 }, {}],
      ["maxEntriesPerCandidate", { maxEntriesPerCandidate: 500_001 }, {}],
    ];
    it.each(variants)("changes when %s changes", (_n, raw, places) => {
      expect(makeConfig(raw, places).digest).not.toBe(makeConfig().digest);
    });
  });
});

describe("defaultStateDir", () => {
  it("uses an absolute XDG_STATE_HOME", () => {
    expect(defaultStateDir(HOME, { XDG_STATE_HOME: "/var/xdg" })).toBe("/var/xdg/disk-janitor");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(defaultStateDir(HOME, {})).toBe("/home/dev/.local/state/disk-janitor");
  });

  it.each(["", "relative/state", "./state"])("ignores the unusable XDG_STATE_HOME %j", (v) => {
    expect(defaultStateDir(HOME, { XDG_STATE_HOME: v })).toBe("/home/dev/.local/state/disk-janitor");
  });

  it("ignores unrelated variables", () => {
    expect(defaultStateDir(HOME, { XDG_CONFIG_HOME: "/x", HOME: "/y" })).toBe("/home/dev/.local/state/disk-janitor");
  });
});

describe("parseRawConfig", () => {
  const parse = (v: unknown) => parseRawConfig(JSON.stringify(v));

  it("accepts an empty object and a full object", () => {
    expect(parse({})).toEqual({});
    const full: RawConfig = {
      roots: ["a"],
      home: "/h",
      stateDir: "/s",
      detectors: ["docker"],
      packageCaches: true,
      dockerApply: false,
      staleDays: 0,
      buildMinAgeDays: 3650,
      cacheMinAgeDays: 1,
      minSizeBytes: 0,
      maxDepth: 16,
      maxCandidates: 5000,
      maxEntriesPerCandidate: 5_000_000,
    };
    expect(parse(full)).toEqual(full);
  });

  it.each([
    ["unknown key", { nope: 1 }, "config: nope: unknown key"],
    ["roots not an array", { roots: "a" }, "config: roots: expected array"],
    ["empty root string", { roots: [""] }, "string too short"],
    ["non-string root", { roots: [1] }, "expected string"],
    ["too many roots", { roots: Array.from({ length: 65 }, (_, i) => `/r${i}`) }, "too many items"],
    ["empty home", { home: "" }, "string too short"],
    ["empty stateDir", { stateDir: "" }, "string too short"],
    ["unknown detector", { detectors: ["rm"] }, "unexpected value"],
    ["packageCaches not boolean", { packageCaches: "yes" }, "expected boolean"],
    ["dockerApply not boolean", { dockerApply: 1 }, "expected boolean"],
    ["negative staleDays", { staleDays: -1 }, "below minimum"],
    ["staleDays above 3650", { staleDays: 3651 }, "above maximum"],
    ["fractional buildMinAgeDays", { buildMinAgeDays: 1.5 }, "expected safe integer"],
    ["string cacheMinAgeDays", { cacheMinAgeDays: "7" }, "expected safe integer"],
    ["negative minSizeBytes", { minSizeBytes: -1 }, "below minimum"],
    ["maxDepth 0", { maxDepth: 0 }, "below minimum"],
    ["maxDepth 17", { maxDepth: 17 }, "above maximum"],
    ["maxCandidates 0", { maxCandidates: 0 }, "below minimum"],
    ["maxCandidates 5001", { maxCandidates: 5001 }, "above maximum"],
    ["maxEntriesPerCandidate 0", { maxEntriesPerCandidate: 0 }, "below minimum"],
    ["maxEntriesPerCandidate above limit", { maxEntriesPerCandidate: 5_000_001 }, "above maximum"],
  ])("rejects %s", (_n, value, message) => {
    expect(() => parse(value)).toThrow(SchemaError);
    expect(() => parse(value)).toThrow(message);
  });

  it("rejects a NUL byte in a path string", () => {
    expect(() => parse({ roots: ["a\0b"] })).toThrow("NUL byte");
  });

  it.each(["", "{", "[]", "null", "42", '"x"'])("rejects the text %j", (t) => {
    expect(() => parseRawConfig(t)).toThrow(SchemaError);
  });

  it("reports invalid JSON distinctly", () => {
    expect(() => parseRawConfig("{")).toThrow("config: not valid JSON");
  });

  it("rejects text over the size limit", () => {
    expect(() => parseRawConfig(" ".repeat(MAX_CONFIG_BYTES + 1))).toThrow(`config: larger than ${MAX_CONFIG_BYTES} bytes`);
  });

  it("measures the size limit in bytes", () => {
    expect(() => parseRawConfig('{"home":"' + "é".repeat(MAX_CONFIG_BYTES / 2) + '"}')).toThrow("larger than");
  });

  it("buildConfig turns parsed input into the same config as the equivalent literal", () => {
    const raw = parse({ staleDays: 12, packageCaches: true });
    expect(buildConfig(raw, { roots: [ROOT], home: HOME, stateDir: STATE_DIR })).toEqual(makeConfig({ staleDays: 12, packageCaches: true }));
  });
});
