import { describe, expect, it } from "vitest";
import type { Plan } from "../../src/domain/model/types.js";
import {
  computePlanDigest,
  isPlanTooOld,
  MAX_PLAN_AGE_MS,
  newPlanId,
  PLAN_ID_RE,
  PlanAggregate,
  PlanIntegrityError,
  PlanInvariantError,
  planTotals,
  PlanTooOldError,
  serializePlan,
  type PlanInput,
} from "../../src/domain/plan/plan.js";
import { canonicalJson, sha256Hex } from "../../src/domain/shared/canonical.js";
import { dockerInput, fsInput, makeConfig, pick, prng, randInt, ROOT } from "../support/builders.js";

const NOW = Date.UTC(2026, 0, 1, 12, 30, 45);
const HEX = "0a1b2c3d";
const input = (...paths: string[]): PlanInput => ({ fs: paths.map((p) => fsInput(p)), docker: [], reports: [] });
const create = (i: PlanInput, config = makeConfig(), now = NOW, hex = HEX) => PlanAggregate.create(config, i, now, hex);
const A = `${ROOT}/alpha/node_modules`;
const B = `${ROOT}/beta/node_modules`;

/** Re-sign a modified plan document so only structural checks can catch the change. */
function resign(doc: Plan): string {
  return serializePlan({ ...doc, digest: computePlanDigest(doc) });
}

describe("newPlanId", () => {
  it("formats the creation time and the random part", () => {
    expect(newPlanId(NOW, HEX)).toBe("plan-20260101T123045Z-0a1b2c3d");
  });

  it("matches PLAN_ID_RE and drops milliseconds", () => {
    const id = newPlanId(NOW + 999, "ffffffff");
    expect(id).toMatch(PLAN_ID_RE);
    expect(id).toBe("plan-20260101T123045Z-ffffffff");
  });

  it("is UTC and zero-padded", () => {
    expect(newPlanId(Date.UTC(2030, 11, 31, 0, 0, 1), "00000000")).toBe("plan-20301231T000001Z-00000000");
  });

  it.each(["", "abc", "0a1b2c3", "0a1b2c3d0", "0A1B2C3D", "zzzzzzzz", "0a1b2c3\n"])("rejects the random part %j", (h) => {
    expect(() => newPlanId(NOW, h)).toThrow(PlanIntegrityError);
    expect(() => newPlanId(NOW, h)).toThrow("plan id needs 8 hex characters");
  });
});

describe("PlanAggregate.create", () => {
  it("builds a plan bound to the config with numbered candidates", () => {
    const config = makeConfig();
    const plan = create(input(A, B), config).document;
    expect(plan.version).toBe(1);
    expect(plan.id).toBe("plan-20260101T123045Z-0a1b2c3d");
    expect(plan.createdAt).toBe(NOW);
    expect(plan.configDigest).toBe(config.digest);
    expect(plan.config.roots).toEqual([ROOT]);
    expect(plan.candidates.map((c) => c.id)).toEqual(["c0001", "c0002"]);
    expect(plan.candidates.map((c) => (c.kind === "fs" ? c.path : c.resource))).toEqual([A, B]);
    expect(plan.digest).toBe(computePlanDigest(plan));
  });

  it("exposes id and digest of the document", () => {
    const agg = create(input(A));
    expect(agg.id).toBe(agg.document.id);
    expect(agg.digest).toBe(agg.document.digest);
    expect(agg.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("numbers file system candidates first, then docker ones", () => {
    const config = makeConfig({ dockerApply: true });
    const agg = create({ fs: [fsInput(A)], docker: [dockerInput("build-cache"), dockerInput("dangling-images")], reports: [] }, config);
    expect(agg.document.candidates.map((c) => `${c.id}:${c.kind}`)).toEqual(["c0001:fs", "c0002:docker", "c0003:docker"]);
  });

  it("accepts an empty plan", () => {
    const agg = create({ fs: [], docker: [], reports: [] });
    expect(agg.document.candidates).toEqual([]);
    expect(agg.totals()).toEqual({ fsBytes: 0, dockerBytes: 0, fsCount: 0, dockerCount: 0 });
  });

  it("keeps report-only findings", () => {
    const agg = create({ fs: [], docker: [], reports: [{ detector: "docker", title: "t", detail: "d", size: 5 }] });
    expect(agg.document.reports).toEqual([{ detector: "docker", title: "t", detail: "d", size: 5 }]);
  });

  it("accepts siblings whose names share a prefix", () => {
    expect(() => create(input(`${ROOT}/app/node_modules`, `${ROOT}/app/node_modules2`))).not.toThrow();
  });

  it("accepts a documented package cache location when the package-cache detector is enabled", () => {
    const config = makeConfig({ packageCaches: true });
    const cache = "/home/dev/.npm/_cacache";
    expect(() => create({ fs: [fsInput(cache, { detector: "package-cache" })], docker: [], reports: [] }, config)).not.toThrow();
  });

  describe("invariants", () => {
    const rejects = (i: PlanInput, message: string | RegExp, config = makeConfig(), type: typeof PlanInvariantError = PlanInvariantError) => {
      expect(() => create(i, config)).toThrow(type);
      expect(() => create(i, config)).toThrow(message);
    };

    it.each([
      ["relative", "projects/app/node_modules"],
      ["with dot segments", `${ROOT}/app/../app/node_modules`],
      ["with parent segments", `${ROOT}/../projects/app/node_modules`],
      ["with a trailing slash", `${ROOT}/app/node_modules/`],
      ["with a doubled slash", `${ROOT}//app/node_modules`],
      ["empty", ""],
      ["containing NUL", `${ROOT}/app/node_modules\0`],
    ])("rejects a %s path", (_n, p) => {
      rejects(input(p), "candidate path is not canonical");
    });

    it("rejects a duplicate path", () => {
      rejects(input(A, B, A), `duplicate candidate path: ${A}`);
    });

    it("rejects a candidate nested inside an earlier one", () => {
      rejects(input(A, `${A}/left-pad/node_modules`), `candidates must not be nested: ${A} and ${A}/left-pad/node_modules`);
    });

    it("rejects a candidate that contains an earlier one", () => {
      rejects(input(`${A}/left-pad/node_modules`, A), "candidates must not be nested");
    });

    it("rejects a candidate outside the roots", () => {
      rejects(input("/home/dev/other/app/node_modules"), "candidate is outside the configured roots: /home/dev/other/app/node_modules");
    });

    it("rejects a sibling directory that merely shares the root's name prefix", () => {
      rejects(input(`${ROOT}-old/app/node_modules`), "outside the configured roots");
    });

    it("rejects a package cache path when the detector is not enabled", () => {
      rejects({ fs: [fsInput("/home/dev/.npm/_cacache", { detector: "package-cache" })], docker: [], reports: [] }, "outside the configured roots");
    });

    it.each([
      [`${ROOT}/app/.git/hooks`, /protected \(path component "\.git" is protected\)/],
      [`${ROOT}/.ssh/node_modules`, /path component "\.ssh" is protected/],
      ["/home/dev/Documents/node_modules", /candidate is protected \(inside the protected location ~\/documents\)/],
      [`${ROOT}/app/.env`, /environment file/],
      [`${ROOT}/my-secrets/node_modules`, /looks like a secret/],
    ])("rejects the protected path %s", (p, message) => {
      rejects(input(p), message, makeConfig({}, { roots: [ROOT, "/home/dev/Documents"] }));
    });

    it("rejects docker candidates unless docker apply is enabled", () => {
      rejects({ fs: [], docker: [dockerInput()], reports: [] }, "docker candidates are only allowed when docker apply is enabled");
    });

    it("accepts docker candidates when docker apply is enabled", () => {
      expect(() => create({ fs: [], docker: [dockerInput()], reports: [] }, makeConfig({ dockerApply: true }))).not.toThrow();
    });

    it("rejects a negative size", () => {
      expect(() => create({ fs: [fsInput(A, { size: -1 })], docker: [], reports: [] })).toThrow("candidate size and entry count cannot be negative");
    });

    it("rejects a negative entry count", () => {
      expect(() => create({ fs: [fsInput(A, { entries: -1 })], docker: [], reports: [] })).toThrow(PlanInvariantError);
    });

    it("accepts zero size and zero entries", () => {
      expect(() => create({ fs: [fsInput(A, { size: 0, entries: 0 })], docker: [], reports: [] })).not.toThrow();
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects the creation time %s", (t) => {
      expect(() => create(input(A), makeConfig(), t)).toThrow("creation time must be a non-negative integer");
    });

    it("accepts creation time zero", () => {
      expect(create(input(A), makeConfig(), 0).id).toBe("plan-19700101T000000Z-0a1b2c3d");
    });

    it.each(["", "xyz", "0a1b2c3", "0A1B2C3D", "0a1b2c3d0"])("rejects the random id part %j", (h) => {
      expect(() => create(input(A), makeConfig(), NOW, h)).toThrow(PlanIntegrityError);
    });

    it("names the invariant error type", () => {
      expect(new PlanInvariantError("x").name).toBe("PlanInvariantError");
      expect(new PlanIntegrityError("x").name).toBe("PlanIntegrityError");
    });
  });
});

describe("PlanAggregate.parse / serialize", () => {
  const original = create(
    { fs: [fsInput(A), fsInput(B, { detector: "build-output", size: 900 })], docker: [dockerInput()], reports: [{ detector: "docker", title: "t", detail: "d" }] },
    makeConfig({ dockerApply: true }),
  );

  it("round-trips to an identical document and digest, with stable text from then on", () => {
    const text = original.serialize();
    const parsed = PlanAggregate.parse(text);
    expect(parsed.document).toEqual(original.document);
    expect(parsed.digest).toBe(original.digest);
    expect(PlanAggregate.parse(parsed.serialize()).serialize()).toBe(parsed.serialize());
  });

  it("serializes as pretty JSON with a trailing newline", () => {
    const text = original.serialize();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "id": ');
    expect(text).toBe(serializePlan(original.document));
  });

  it("escapes display-unsafe characters in the text but parses back to the same data", () => {
    const agg = create({ fs: [fsInput(A, { reason: "bidi \u202e and zero width \u200b" })], docker: [], reports: [] });
    const text = agg.serialize();
    expect(text).not.toContain("\u202e");
    expect(text).toContain("\\u202e");
    expect(PlanAggregate.parse(text).document).toEqual(agg.document);
  });

  it("the digest does not depend on property order in the text", () => {
    const doc = original.document;
    const reversed = Object.fromEntries(Object.entries(doc).reverse());
    expect(PlanAggregate.parse(JSON.stringify(reversed)).digest).toBe(doc.digest);
    expect(computePlanDigest(reversed as unknown as Plan)).toBe(doc.digest);
  });

  it("the digest is the SHA-256 of the canonical JSON without the digest field", () => {
    const { digest: _d, ...rest } = original.document;
    expect(original.digest).toBe(sha256Hex(canonicalJson(rest)));
  });

  it("a different creation time, config or candidate list gives a different digest", () => {
    const base = create(input(A));
    expect(create(input(A), makeConfig(), NOW + 1000).digest).not.toBe(base.digest);
    expect(create(input(A), makeConfig({ staleDays: 5 })).digest).not.toBe(base.digest);
    expect(create(input(A, B)).digest).not.toBe(base.digest);
    expect(create(input(A), makeConfig(), NOW, "ffffffff").digest).not.toBe(base.digest);
  });

  describe("rejects tampering", () => {
    const doc = original.document;
    const parseError = (text: string) => {
      try {
        PlanAggregate.parse(text);
      } catch (e) {
        expect(e).toBeInstanceOf(PlanIntegrityError);
        return (e as Error).message;
      }
      throw new Error("expected parse to throw");
    };

    it("rejects a changed candidate size (digest mismatch)", () => {
      const changed = { ...doc, candidates: doc.candidates.map((c, i) => (i === 0 ? { ...c, size: c.size + 1 } : c)) };
      expect(parseError(serializePlan(changed as Plan))).toBe("plan digest mismatch: the plan was modified after it was created");
    });

    it("rejects a retargeted candidate path (digest mismatch)", () => {
      const text = original.serialize().replace(A, `${ROOT}/gamma/node_modules`);
      expect(parseError(text)).toContain("plan digest mismatch");
    });

    it("rejects a changed digest field", () => {
      expect(parseError(serializePlan({ ...doc, digest: "0".repeat(64) }))).toContain("plan digest mismatch");
    });

    it("rejects a config changed without updating configDigest, even when re-signed", () => {
      const changed = { ...doc, config: { ...doc.config, staleDays: 1 } };
      expect(parseError(resign(changed))).toBe("plan config digest mismatch");
    });

    it("rejects duplicate candidate ids, even when re-signed", () => {
      const changed = { ...doc, candidates: doc.candidates.map((c) => ({ ...c, id: "c0001" })) };
      expect(parseError(resign(changed))).toBe("duplicate candidate id");
    });

    it("rejects duplicate candidate paths, even when re-signed", () => {
      const [first, , third] = doc.candidates;
      const dup = { ...(first as Plan["candidates"][number]), id: "c0009" };
      expect(parseError(resign({ ...doc, candidates: [first as never, dup, third as never] }))).toBe("duplicate candidate path");
    });

    it("rejects an unknown top-level key", () => {
      expect(parseError(JSON.stringify({ ...doc, extra: 1 }))).toMatch(/plan: extra: unknown key/);
    });

    it("rejects an unknown candidate key", () => {
      const changed = { ...doc, candidates: [{ ...(doc.candidates[0] as object), extra: 1 }] };
      expect(parseError(resign(changed as never))).toMatch(/unknown key/);
    });

    it.each([
      ["version", 2],
      ["id", "plan-1"],
      ["createdAt", "yesterday"],
      ["configDigest", "xyz"],
      ["digest", 5],
    ])("rejects a bad %s", (key, value) => {
      expect(parseError(JSON.stringify({ ...doc, [key]: value }))).toMatch(/^plan: /);
    });

    it("rejects a non-canonical candidate path in the text", () => {
      const changed = { ...doc, candidates: [{ ...(doc.candidates[0] as object), path: "relative/path" }] };
      expect(parseError(JSON.stringify(changed))).toContain("not a canonical absolute path");
    });

    it("rejects an unknown candidate kind", () => {
      const changed = { ...doc, candidates: [{ kind: "vm", id: "c0001" }] };
      expect(parseError(JSON.stringify(changed))).toContain("kind: unknown variant");
    });

    it("rejects an unknown detector", () => {
      const changed = { ...doc, candidates: [{ ...(doc.candidates[0] as object), detector: "rm-rf" }] };
      expect(parseError(JSON.stringify(changed))).toContain("unexpected value");
    });

    it.each(["", "{", "[]", "null", "42", '"plan"'])("rejects the text %j", (t) => {
      expect(parseError(t)).toMatch(/^plan: /);
    });

    it("rejects text over the size limit", () => {
      expect(parseError(" ".repeat(8 * 1024 * 1024 + 1))).toBe("plan: larger than 8388608 bytes");
    });

    it("rejects more than 5000 candidates", () => {
      const many = Array.from({ length: 5001 }, (_, i) => ({ ...(doc.candidates[0] as object), id: `c${String(i + 1).padStart(4, "0")}`, path: `${ROOT}/p${i}/node_modules` }));
      expect(parseError(JSON.stringify({ ...doc, candidates: many }))).toContain("too many items");
    });
  });
});

describe("planTotals", () => {
  it("sums file system and docker candidates separately", () => {
    const agg = create(
      { fs: [fsInput(A, { size: 100 }), fsInput(B, { size: 250 })], docker: [dockerInput("build-cache", { size: 7 }), dockerInput("dangling-images", { size: 11 })], reports: [] },
      makeConfig({ dockerApply: true }),
    );
    expect(agg.totals()).toEqual({ fsBytes: 350, dockerBytes: 18, fsCount: 2, dockerCount: 2 });
    expect(planTotals(agg.document)).toEqual(agg.totals());
  });

  it("counts only the kinds that are present", () => {
    expect(create(input(A)).totals()).toEqual({ fsBytes: 4096, dockerBytes: 0, fsCount: 1, dockerCount: 0 });
  });
});

describe("plan age", () => {
  const plan = { createdAt: NOW };

  it("a plan exactly 24 hours old is still allowed", () => {
    expect(MAX_PLAN_AGE_MS).toBe(24 * 3_600_000);
    expect(isPlanTooOld(plan, NOW + MAX_PLAN_AGE_MS)).toBe(false);
  });

  it("24 hours and 1 ms is too old", () => {
    expect(isPlanTooOld(plan, NOW + MAX_PLAN_AGE_MS + 1)).toBe(true);
  });

  it("a fresh plan and a plan created in the future are not too old", () => {
    expect(isPlanTooOld(plan, NOW)).toBe(false);
    expect(isPlanTooOld(plan, NOW - 5000)).toBe(false);
  });

  it("PlanTooOldError carries the message and name", () => {
    const e = new PlanTooOldError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PlanTooOldError");
    expect(e.message).toBe("the plan is older than 24 hours; create a new one");
  });
});

describe("plan properties (seeded)", () => {
  const names = ["app", "web", "api", "lib", "docs", "tools", "site", "core"];

  function randomPaths(r: () => number): string[] {
    const n = randInt(r, 0, 25);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(`${ROOT}/${pick(r, names)}${i}/${pick(r, ["node_modules", "dist", ".next", "build"])}`);
    return out;
  }

  const randomInput = (r: () => number, paths: string[]): PlanInput => ({
    fs: paths.map((p) => fsInput(p, { size: randInt(r, 0, 1e9), entries: randInt(r, 0, 1e6), ageDays: randInt(r, 0, 900), ino: String(randInt(r, 1, 1e9)) })),
    docker: [],
    reports: [],
  });

  it("random valid candidate sets create, serialize and parse back to the identical digest", () => {
    const r = prng(424242);
    for (let i = 0; i < 40; i++) {
      const paths = randomPaths(r);
      const agg = create(randomInput(r, paths), makeConfig(), NOW + randInt(r, 0, 1e9), randInt(r, 0, 0xffffffff).toString(16).padStart(8, "0"));
      const parsed = PlanAggregate.parse(agg.serialize());
      expect(parsed.digest).toBe(agg.digest);
      expect(PlanAggregate.parse(parsed.serialize()).serialize()).toBe(parsed.serialize());
      expect(parsed.document).toEqual(agg.document);
      expect(parsed.document.candidates).toHaveLength(paths.length);
      expect(parsed.totals()).toEqual(agg.totals());
    }
  });

  it("the digest is independent of the order of keys inside each candidate", () => {
    const r = prng(9);
    const paths = randomPaths(r);
    const agg = create(randomInput(r, paths));
    const doc = JSON.parse(agg.serialize()) as Plan;
    const shuffled = { ...doc, candidates: doc.candidates.map((c) => Object.fromEntries(Object.entries(c).reverse())) };
    expect(PlanAggregate.parse(JSON.stringify(shuffled)).digest).toBe(agg.digest);
  });

  it("any injected duplicate path is always rejected", () => {
    const r = prng(1);
    for (let i = 0; i < 40; i++) {
      const paths = randomPaths(r);
      if (paths.length === 0) continue;
      const dup = pick(r, paths);
      const at = randInt(r, 0, paths.length);
      const withDup = [...paths.slice(0, at), dup, ...paths.slice(at)];
      expect(() => create(randomInput(r, withDup))).toThrow(PlanInvariantError);
    }
  });

  it("any injected nested pair, in either order, is always rejected", () => {
    const r = prng(2);
    for (let i = 0; i < 40; i++) {
      const paths = randomPaths(r);
      if (paths.length === 0) continue;
      const parent = pick(r, paths);
      const child = `${parent}/${pick(r, names)}/nested`;
      const withNested = r() < 0.5 ? [child, ...paths] : [...paths, child];
      expect(() => create(randomInput(r, withNested))).toThrow(/nested/);
    }
  });

  it("any candidate placed outside the roots is always rejected", () => {
    const r = prng(3);
    for (let i = 0; i < 20; i++) {
      const outside = `/home/dev/${pick(r, ["elsewhere", "other", "projects2"])}/${pick(r, names)}/node_modules`;
      const paths = randomPaths(r);
      expect(() => create(randomInput(r, [...paths, outside]))).toThrow(/outside the configured roots/);
    }
  });
});
