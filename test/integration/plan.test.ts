import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/domain/shared/canonical.js";
import { buildPlan, writePlanFile } from "../../src/composition/planning.js";
import { computePlanDigest, MAX_PLAN_BYTES, parsePlan, PLAN_ID_RE, PlanIntegrityError, planTotals } from "../../src/domain/plan/plan.js";
import { scan } from "../../src/composition/discovery.js";
import type { FsCandidate, Plan } from "../../src/domain/model/types.js";
import { makeSandbox, makeConfig, testDeps } from "../support/helpers.js";
import { clone, forge, mixedPlan, mulberry32, planPath } from "../support/helpers-stateplan.js";

const fsCands = (p: Plan) => p.candidates.filter((c): c is FsCandidate => c.kind === "fs");

describe("buildPlan", () => {
  it("fills id, createdAt, config digest, sequential ids and a valid digest", async () => {
    const sb = makeSandbox();
    const { config, plan, deps } = await mixedPlan(sb);
    expect(plan.version).toBe(1);
    expect(plan.id).toMatch(PLAN_ID_RE);
    expect(plan.createdAt).toBeLessThanOrEqual(deps.now());
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.configDigest).toBe(config.digest);
    expect(plan.configDigest).toBe(sha256Hex(canonicalJson(plan.config)));
    expect(plan.candidates.length).toBeGreaterThanOrEqual(3);
    plan.candidates.forEach((c, i) => expect(c.id).toBe(`c${String(i + 1).padStart(4, "0")}`));
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.digest).toBe(computePlanDigest(plan));
  });

  it("encodes the injected clock in id and createdAt", async () => {
    const sb = makeSandbox();
    const deps = testDeps();
    const config = await makeConfig(sb, {}, deps);
    const result = await scan(config, deps);
    const t = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    const plan = buildPlan(config, result, t);
    expect(plan.createdAt).toBe(t);
    expect(plan.id).toMatch(/^plan-20260102T030405Z-[0-9a-f]{8}$/);
  });

  it("gives two builds of the same scan different ids and digests", async () => {
    const sb = makeSandbox();
    const { config, deps } = await mixedPlan(sb);
    const result = await scan(config, deps);
    const a = buildPlan(config, result, 1_000_000);
    const b = buildPlan(config, result, 1_000_000);
    expect(a.id).not.toBe(b.id);
    expect(a.digest).not.toBe(b.digest);
  });

  it("binds only the config core (no stateDir) into the plan", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    expect(Object.keys(plan.config).sort()).toEqual(
      ["buildMinAgeDays", "cacheMinAgeDays", "detectors", "dockerApply", "home", "maxCandidates", "maxDepth", "maxEntriesPerCandidate", "minSizeBytes", "roots", "staleDays"],
    );
    expect(plan.config.roots).toEqual([sb.projects]);
    expect(JSON.stringify(plan)).not.toContain(sb.state);
  });

  it("planTotals sums fs bytes and counts", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const t = planTotals(plan);
    expect(t.fsCount).toBe(fsCands(plan).length);
    expect(t.fsBytes).toBe(fsCands(plan).reduce((s, c) => s + c.size, 0));
    expect(t.dockerCount).toBe(0);
    expect(t.dockerBytes).toBe(0);
  });
});

describe("computePlanDigest", () => {
  it("is stable, ignores the digest field and key order", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    expect(computePlanDigest(plan)).toBe(computePlanDigest(clone(plan)));
    expect(computePlanDigest({ ...plan, digest: "f".repeat(64) })).toBe(plan.digest);
    const { digest: _d, ...rest } = plan;
    expect(computePlanDigest(rest)).toBe(plan.digest);
    const reversed = Object.fromEntries(Object.entries(plan).reverse()) as unknown as Plan;
    const c0 = reversed.candidates[0] as FsCandidate;
    reversed.candidates[0] = Object.fromEntries(Object.entries(c0).reverse()) as unknown as FsCandidate;
    expect(computePlanDigest(reversed)).toBe(plan.digest);
  });

  it("changes when any bound field changes", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    expect(forge(plan, (p) => (p.createdAt += 1)).digest).not.toBe(plan.digest);
    expect(forge(plan, (p) => (p.config.staleDays += 1)).digest).not.toBe(plan.digest);
  });
});

describe("writePlanFile / parsePlan", () => {
  it("writes mode 0600, refuses to overwrite, and the file parses back identically", async () => {
    const sb = makeSandbox();
    const { plan, state } = await mixedPlan(sb);
    const path = planPath(sb);
    await writePlanFile(path, plan);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(writePlanFile(path, plan)).rejects.toMatchObject({ code: "EEXIST" });
    expect(parsePlan(readFileSync(path, "utf8"))).toEqual(plan);
    expect(state.plansDir).toContain("plans");
  });

  it("round-trips a plan with no candidates", async () => {
    const sb = makeSandbox();
    const deps = testDeps();
    const config = await makeConfig(sb, {}, deps);
    const plan = buildPlan(config, await scan(config, deps), deps.now());
    expect(plan.candidates).toEqual([]);
    expect(parsePlan(JSON.stringify(plan))).toEqual(plan);
  });
});

describe("tampering is detected by the digest", () => {
  const cases: Array<[string, (p: Plan) => void]> = [
    ["candidate path", (p) => ((p.candidates[0] as FsCandidate).path = "/etc")],
    ["candidate size", (p) => ((p.candidates[0] as FsCandidate).size += 1)],
    ["candidate ino", (p) => ((p.candidates[0] as FsCandidate).ino = "1")],
    ["candidate dev", (p) => ((p.candidates[0] as FsCandidate).dev = "1")],
    ["reason", (p) => ((p.candidates[0] as FsCandidate).reason = "looks harmless")],
    ["added candidate", (p) => p.candidates.push({ ...(clone(p.candidates[0]) as FsCandidate), id: "c0099", path: "/tmp/x" })],
    ["removed candidate", (p) => void p.candidates.pop()],
    ["config roots", (p) => (p.config.roots = ["/"])],
    ["createdAt", (p) => (p.createdAt += 1)],
    ["plan id", (p) => (p.id = p.id.slice(0, -1) + (p.id.endsWith("0") ? "1" : "0"))],
  ];
  for (const [name, mutate] of cases) {
    it(`rejects a modified ${name}`, async () => {
      const sb = makeSandbox();
      const { plan } = await mixedPlan(sb);
      const bad = clone(plan);
      mutate(bad);
      expect(() => parsePlan(JSON.stringify(bad))).toThrow(PlanIntegrityError);
      expect(() => parsePlan(JSON.stringify(bad))).toThrow(/digest mismatch/);
    });
  }

  it("accepts a candidate edit with a recomputed digest, but the digest differs from the approved one", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const forged = forge(plan, (p) => ((p.candidates[0] as FsCandidate).path = sb.home));
    expect(parsePlan(JSON.stringify(forged)).digest).toBe(forged.digest);
    expect(forged.digest).not.toBe(plan.digest);
  });

  it("rejects forged config roots with a recomputed plan digest (config digest no longer matches)", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const forged = forge(plan, (p) => (p.config.roots = ["/"]));
    expect(() => parsePlan(JSON.stringify(forged))).toThrow(/config digest mismatch/);
  });
});

describe("strict schema", () => {
  const bad = (text: string) => expect(() => parsePlan(text)).toThrow(PlanIntegrityError);

  it("rejects invalid JSON and non-objects", () => {
    bad("{not json");
    bad("");
    bad("[]");
    bad("null");
    bad('"plan"');
  });

  it("rejects an unknown top-level key, even with a valid digest", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const withExtra = { ...plan, extra: 1 };
    expect(() => parsePlan(JSON.stringify(withExtra))).toThrow(/unknown key/);
  });

  it("rejects an unknown candidate key", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const p = clone(plan) as unknown as { candidates: Array<Record<string, unknown>> };
    (p.candidates[0] as Record<string, unknown>)["exec"] = "rm -rf /";
    bad(JSON.stringify(p));
  });

  it("rejects a wrong version", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    bad(JSON.stringify({ ...forge(plan, () => undefined), version: 2 }));
  });

  const pathCases: Array<[string, string]> = [
    ["a .. segment", "/a/../etc"],
    ["a relative path", "a/b"],
    ["a trailing slash", "/a/b/"],
    ["a double slash", "/a//b"],
    ["a dot segment", "/a/./b"],
    ["a NUL byte", "/a/b\0c"],
    ["an empty path", ""],
  ];
  for (const [name, path] of pathCases) {
    it(`rejects ${name} as candidate path even with a valid digest`, async () => {
      const sb = makeSandbox();
      const { plan } = await mixedPlan(sb);
      const forged = forge(plan, (p) => ((p.candidates[0] as FsCandidate).path = path));
      bad(JSON.stringify(forged));
    });
  }

  it("rejects a non-canonical root in config", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    bad(JSON.stringify(forge(plan, (p) => (p.config.roots = ["/a/../b"]))));
  });

  it("rejects duplicate candidate ids", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const forged = forge(plan, (p) => ((p.candidates[1] as FsCandidate).id = (p.candidates[0] as FsCandidate).id));
    expect(() => parsePlan(JSON.stringify(forged))).toThrow(/duplicate candidate id/);
  });

  it("rejects duplicate candidate paths", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const forged = forge(plan, (p) => ((p.candidates[1] as FsCandidate).path = (p.candidates[0] as FsCandidate).path));
    expect(() => parsePlan(JSON.stringify(forged))).toThrow(/duplicate candidate path/);
  });

  it("rejects malformed plan ids, candidate ids and decimal strings", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    for (const id of ["plan-1", "plan-20260102T030405Z-ABCDEF12", "../x", ""]) {
      bad(JSON.stringify(forge(plan, (p) => (p.id = id))));
    }
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).id = "x1"))));
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).ino = "-1"))));
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).ino = "1".repeat(21)))));
  });

  it("rejects negative or fractional numbers", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).size = -1))));
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).size = 1.5))));
  });

  it("rejects an oversized file (> 8 MiB) without parsing it", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const text = JSON.stringify(plan) + " ".repeat(MAX_PLAN_BYTES);
    expect(() => parsePlan(text)).toThrow(/larger than/);
  });

  it("rejects arrays over their limits", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const many = forge(plan, (p) => {
      const c = p.candidates[0] as FsCandidate;
      p.candidates = Array.from({ length: 5001 }, (_, i) => ({ ...c, id: `c${String(i + 1).padStart(4, "0")}`, path: `/x/${i}` }));
    });
    expect(() => parsePlan(JSON.stringify(many))).toThrow(/too many items/);
    const roots = forge(plan, (p) => (p.config.roots = Array.from({ length: 65 }, (_, i) => `/r${i}`)));
    expect(() => parsePlan(JSON.stringify(roots))).toThrow(/too many items/);
  });

  it("rejects huge strings", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    expect(() => parsePlan(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).reason = "x".repeat(1025)))))).toThrow(/too long/);
    expect(() => parsePlan(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).path = "/" + "a".repeat(5000)))))).toThrow(/too long/);
  });

  it("rejects an unknown detector", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as FsCandidate).detector = "evil" as never))));
  });

  it("rejects an unknown candidate kind", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    bad(JSON.stringify(forge(plan, (p) => ((p.candidates[0] as unknown as { kind: string }).kind = "shell"))));
  });
});

describe("random single-byte mutations", () => {
  it("never yield a different plan that parses", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const path = planPath(sb);
    await writePlanFile(path, plan);
    const original = readFileSync(path);
    const rnd = mulberry32(0xd15c);
    let rejected = 0;
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const buf = Buffer.from(original);
      const pos = Math.floor(rnd() * buf.length);
      const kind = Math.floor(rnd() * 3);
      if (kind === 0) buf[pos] = (buf[pos] as number) ^ (1 << Math.floor(rnd() * 8));
      else if (kind === 1) buf[pos] = Math.floor(rnd() * 256);
      else buf[pos] = [0x20, 0x09, 0x0a][Math.floor(rnd() * 3)] as number;
      let parsed: Plan | undefined;
      try {
        parsed = parsePlan(buf.toString("utf8"));
      } catch (e) {
        expect(e).toBeInstanceOf(PlanIntegrityError);
        rejected++;
        continue;
      }
      accepted++;
      expect(parsed.digest).toBe(plan.digest);
      expect(parsed).toEqual(plan);
    }
    expect(rejected).toBeGreaterThan(300);
    expect(rejected + accepted).toBe(400);
  });

  it("also holds for every whitespace byte flipped to a non-whitespace byte", async () => {
    const sb = makeSandbox();
    const { plan } = await mixedPlan(sb);
    const text = JSON.stringify(plan, null, 2);
    const rnd = mulberry32(7);
    const ws = [...text].flatMap((ch, i) => (ch === " " || ch === "\n" ? [i] : []));
    for (let i = 0; i < 120; i++) {
      const pos = ws[Math.floor(rnd() * ws.length)] as number;
      const mutated = text.slice(0, pos) + "x" + text.slice(pos + 1);
      expect(() => parsePlan(mutated)).toThrow(PlanIntegrityError);
    }
  });
});
