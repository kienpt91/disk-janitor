import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { configCore, configCoreDigest, defaultStateDir, DEFAULTS, parseRawConfig, type RawConfig } from "../src/domain/model/config.js";
import { loadConfigFile } from "../src/infrastructure/config-file.js";
import { resolveConfig } from "../src/composition/planning.js";
import { canonicalJson, sha256Hex } from "../src/domain/shared/canonical.js";
import { makeConfig, makeSandbox, testDeps, writeText, type Sandbox } from "./helpers.js";

const deps = testDeps();

function resolveFor(sb: Sandbox, raw: RawConfig = {}, env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return resolveConfig({ roots: [sb.projects], home: sb.home, stateDir: sb.state, ...raw }, deps, { env, cwd });
}

describe("resolveConfig defaults", () => {
  it("applies the documented defaults", async () => {
    const sb = makeSandbox();
    const c = await resolveFor(sb);
    expect(c.roots).toEqual([sb.projects]);
    expect(c.home).toBe(sb.home);
    expect(c.stateDir).toBe(sb.state);
    expect(c.detectors).toEqual(["node-modules", "build-output", "docker", "git-worktrees"]);
    expect(c.dockerApply).toBe(false);
    expect(c.staleDays).toBe(30);
    expect(c.buildMinAgeDays).toBe(7);
    expect(c.cacheMinAgeDays).toBe(7);
    expect(c.minSizeBytes).toBe(1_048_576);
    expect(c.maxDepth).toBe(8);
    expect(c.maxCandidates).toBe(500);
    expect(c.maxEntriesPerCandidate).toBe(500_000);
    expect(DEFAULTS.minSizeBytes).toBe(1_048_576);
  });

  it("package-cache is opt-in via packageCaches", async () => {
    const sb = makeSandbox();
    expect((await resolveFor(sb)).detectors).not.toContain("package-cache");
    const c = await resolveFor(sb, { packageCaches: true });
    expect(c.detectors).toEqual(["node-modules", "build-output", "package-cache", "docker", "git-worktrees"]);
  });

  it("dockerApply adds docker even when it was not listed", async () => {
    const sb = makeSandbox();
    const c = await resolveFor(sb, { detectors: ["node-modules"], dockerApply: true });
    expect(c.detectors).toEqual(["node-modules", "docker"]);
    expect(c.dockerApply).toBe(true);
  });

  it("explicit detectors replace the defaults and are returned in canonical order, deduplicated", async () => {
    const sb = makeSandbox();
    const c = await resolveFor(sb, { detectors: ["git-worktrees", "node-modules", "node-modules"] });
    expect(c.detectors).toEqual(["node-modules", "git-worktrees"]);
  });

  it("canonicalizes a symlinked home", async () => {
    const sb = makeSandbox();
    symlinkSync(sb.home, join(sb.base, "homelink"));
    const c = await resolveConfig({ roots: [sb.projects], home: join(sb.base, "homelink"), stateDir: sb.state }, deps, { env: {} });
    expect(c.home).toBe(sb.home);
  });

  it("rejects a home that does not exist", async () => {
    const sb = makeSandbox();
    const missing = join(sb.base, "nohome");
    await expect(resolveConfig({ roots: [sb.projects], home: missing }, deps, { env: {} })).rejects.toThrow(`home directory does not exist: ${missing}`);
  });

  it("refuses to resolve without roots", async () => {
    const sb = makeSandbox();
    await expect(resolveConfig({ home: sb.home, stateDir: sb.state }, deps, { env: {} })).rejects.toThrow("no roots configured");
  });

  it("resolves a relative stateDir and home against cwd", async () => {
    const sb = makeSandbox();
    const c = await resolveConfig({ roots: [sb.projects], home: "home", stateDir: "st" }, deps, { env: {}, cwd: sb.base });
    expect(c.home).toBe(sb.home);
    expect(c.stateDir).toBe(join(sb.base, "st"));
  });

  it("derives the default stateDir from the home when none is given", async () => {
    const sb = makeSandbox();
    const c = await resolveConfig({ roots: [sb.projects], home: sb.home }, deps, { env: {} });
    expect(c.stateDir).toBe(join(sb.home, ".local", "state", "disk-janitor"));
  });

  it("makeConfig helper keeps its small test thresholds", async () => {
    const sb = makeSandbox();
    const c = await makeConfig(sb);
    expect(c.minSizeBytes).toBe(1);
  });
});

describe("config digest", () => {
  it("is the sha256 of the canonical core and is stable", async () => {
    const sb = makeSandbox();
    const a = await resolveFor(sb);
    const b = await resolveFor(sb);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).toBe(sha256Hex(canonicalJson(configCore(a))));
    expect(configCoreDigest(configCore(a))).toBe(a.digest);
  });

  it("core excludes stateDir and digest", async () => {
    const sb = makeSandbox();
    const core = configCore(await resolveFor(sb));
    expect(Object.keys(core).sort()).toEqual(
      ["buildMinAgeDays", "cacheMinAgeDays", "detectors", "dockerApply", "home", "maxCandidates", "maxDepth", "maxEntriesPerCandidate", "minSizeBytes", "roots", "staleDays"].sort(),
    );
  });

  it("does not change with stateDir", async () => {
    const sb = makeSandbox();
    const a = await resolveFor(sb, { stateDir: join(sb.base, "s1") });
    const b = await resolveFor(sb, { stateDir: join(sb.base, "s2") });
    expect(a.stateDir).not.toBe(b.stateDir);
    expect(a.digest).toBe(b.digest);
  });

  it("changes when roots change", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "other"));
    const a = await resolveFor(sb);
    const b = await resolveFor(sb, { roots: [join(sb.home, "other")] });
    const c = await resolveFor(sb, { roots: [sb.projects, join(sb.home, "other")] });
    expect(new Set([a.digest, b.digest, c.digest]).size).toBe(3);
  });

  it("is independent of root order", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "other"));
    const a = await resolveFor(sb, { roots: [sb.projects, join(sb.home, "other")] });
    const b = await resolveFor(sb, { roots: [join(sb.home, "other"), sb.projects] });
    expect(a.digest).toBe(b.digest);
  });

  it.each<[string, RawConfig]>([
    ["staleDays", { staleDays: 31 }],
    ["buildMinAgeDays", { buildMinAgeDays: 8 }],
    ["cacheMinAgeDays", { cacheMinAgeDays: 9 }],
    ["minSizeBytes", { minSizeBytes: 5 }],
    ["maxDepth", { maxDepth: 3 }],
    ["maxCandidates", { maxCandidates: 10 }],
    ["maxEntriesPerCandidate", { maxEntriesPerCandidate: 10 }],
    ["detectors", { detectors: ["node-modules"] }],
    ["packageCaches", { packageCaches: true }],
    ["dockerApply", { dockerApply: true }],
  ])("changes when %s changes", async (_name, override) => {
    const sb = makeSandbox();
    const base = await resolveFor(sb);
    const changed = await resolveFor(sb, override);
    expect(changed.digest).not.toBe(base.digest);
  });

  it("changes when the home changes", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.base, "home2", "projects"), { recursive: true });
    const a = await resolveFor(sb);
    const b = await resolveConfig({ roots: [sb.projects], home: join(sb.base, "home2"), stateDir: sb.state }, deps, { env: {} });
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("config parsing", () => {
  it("rejects unknown keys", () => {
    expect(() => parseRawConfig('{"roots":["/x"],"bogus":1}')).toThrow("config: bogus: unknown key");
  });

  it("rejects wrong types", () => {
    expect(() => parseRawConfig('{"roots":"/x"}')).toThrow("config: roots: expected array");
    expect(() => parseRawConfig('{"staleDays":"30"}')).toThrow("config: staleDays: expected safe integer");
    expect(() => parseRawConfig('{"packageCaches":1}')).toThrow("config: packageCaches: expected boolean");
    expect(() => parseRawConfig('{"detectors":["nope"]}')).toThrow("detectors[0]: unexpected value");
  });

  it("range-checks thresholds", () => {
    expect(() => parseRawConfig('{"maxDepth":0}')).toThrow("config: maxDepth: below minimum");
    expect(() => parseRawConfig('{"maxDepth":17}')).toThrow("config: maxDepth: above maximum");
    expect(() => parseRawConfig('{"maxCandidates":0}')).toThrow("below minimum");
    expect(() => parseRawConfig('{"maxCandidates":5001}')).toThrow("above maximum");
    expect(() => parseRawConfig('{"staleDays":-1}')).toThrow("below minimum");
    expect(() => parseRawConfig('{"staleDays":3651}')).toThrow("above maximum");
    expect(() => parseRawConfig('{"minSizeBytes":-1}')).toThrow("below minimum");
    expect(() => parseRawConfig('{"maxEntriesPerCandidate":5000001}')).toThrow("above maximum");
    expect(parseRawConfig('{"maxDepth":1,"staleDays":0}')).toEqual({ maxDepth: 1, staleDays: 0 });
  });

  it("rejects empty roots entries, NUL in strings and too many roots", () => {
    expect(() => parseRawConfig('{"roots":[""]}')).toThrow("string too short");
    expect(() => parseRawConfig('{"roots":["a\\u0000b"]}')).toThrow("NUL byte");
    expect(() => parseRawConfig(JSON.stringify({ roots: Array.from({ length: 65 }, (_, i) => `/r${i}`) }))).toThrow("roots: too many items");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRawConfig("{")).toThrow("config: not valid JSON");
  });

  it("accepts an empty object", () => {
    expect(parseRawConfig("{}")).toEqual({});
  });
});

describe("loadConfigFile", () => {
  it("loads a valid config file", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "dj.json");
    writeText(file, JSON.stringify({ roots: ["/x"], staleDays: 12, packageCaches: true }));
    expect(await loadConfigFile(file)).toEqual({ roots: ["/x"], staleDays: 12, packageCaches: true });
  });

  it("rejects unknown keys in the file", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "dj.json");
    writeText(file, '{"rooots":[]}');
    await expect(loadConfigFile(file)).rejects.toThrow("config: rooots: unknown key");
  });

  it("rejects wrong types in the file", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "dj.json");
    writeText(file, '{"dockerApply":"yes"}');
    await expect(loadConfigFile(file)).rejects.toThrow("config: dockerApply: expected boolean");
  });

  it("rejects files larger than 64 KiB", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "big.json");
    writeText(file, "{" + " ".repeat(64 * 1024) + "}");
    await expect(loadConfigFile(file)).rejects.toThrow("larger than 65536 bytes");
  });

  it("accepts a file of exactly 64 KiB", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "edge.json");
    writeText(file, "{}" + " ".repeat(64 * 1024 - 2));
    expect(await loadConfigFile(file)).toEqual({});
  });

  it("rejects a directory", async () => {
    const sb = makeSandbox();
    await expect(loadConfigFile(sb.base)).rejects.toThrow(`config is not a regular file: ${sb.base}`);
  });

  it("rejects a missing file", async () => {
    const sb = makeSandbox();
    await expect(loadConfigFile(join(sb.base, "absent.json"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects invalid JSON in the file", async () => {
    const sb = makeSandbox();
    const file = join(sb.base, "bad.json");
    writeText(file, "not json");
    await expect(loadConfigFile(file)).rejects.toThrow("config: not valid JSON");
  });
});

describe("defaultStateDir", () => {
  it("uses an absolute XDG_STATE_HOME", () => {
    expect(defaultStateDir("/home/u", { XDG_STATE_HOME: "/var/xdg" })).toBe("/var/xdg/disk-janitor");
  });

  it("ignores a relative XDG_STATE_HOME", () => {
    expect(defaultStateDir("/home/u", { XDG_STATE_HOME: "rel/state" })).toBe("/home/u/.local/state/disk-janitor");
  });

  it("ignores an empty XDG_STATE_HOME", () => {
    expect(defaultStateDir("/home/u", { XDG_STATE_HOME: "" })).toBe("/home/u/.local/state/disk-janitor");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(defaultStateDir("/home/u", {})).toBe("/home/u/.local/state/disk-janitor");
  });

  it("resolveConfig honours XDG_STATE_HOME from the given env", async () => {
    const sb = makeSandbox();
    const xdg = join(sb.base, "xdg");
    const c = await resolveConfig({ roots: [sb.projects], home: sb.home }, deps, { env: { XDG_STATE_HOME: xdg } });
    expect(c.stateDir).toBe(join(xdg, "disk-janitor"));
  });
});
