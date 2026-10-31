import { describe, expect, it } from "vitest";
import { IllegalTransitionError, QuarantineError } from "../../../src/domain/quarantine/errors.js";
import { assertPlanId, assertStoredName, Manifest, purgeAgeMs, purgeSetDigest, storedName, type ManifestBody } from "../../../src/domain/quarantine/manifest.js";
import { DAY_MS } from "../../../src/domain/model/types.js";
import { fakeSigner, HOME, manifestInput, newManifest, PLAN_ID, ROOT, rng } from "../../support/domain-fixtures.js";

describe("Manifest creation", () => {
  it("lists one pending entry per candidate, numbered in order with 4-digit stored names", () => {
    const m = newManifest(3);
    expect(m.entries.map((e) => [e.index, e.stored, e.status])).toEqual([
      [1, "0001", "pending"],
      [2, "0002", "pending"],
      [3, "0003", "pending"],
    ]);
    expect(m.entries[1]).toMatchObject({ originalPath: `${ROOT}/p2/node_modules`, detector: "node-modules", dev: "100", ino: "1002", size: 8192, mtimeMs: 2000 });
    expect(m.planId).toBe(PLAN_ID);
    expect(m.createdAt).toBe(5_000);
    expect(m.scope).toEqual({ roots: [ROOT], home: HOME, detectors: ["node-modules", "build-output"] });
  });

  it("allows a manifest with no entries", () => {
    expect(newManifest(0).entries).toEqual([]);
  });

  it("rejects an invalid plan id, a relative original path and a non-canonical root", () => {
    expect(() => newManifest(1, { planId: "not-a-plan" })).toThrow(QuarantineError);
    expect(() => newManifest(1, { roots: ["relative/root"] })).toThrow(/canonical absolute path/);
    expect(() => newManifest(1, { home: "/a/../b" })).toThrow(/canonical absolute path/);
    const bad = manifestInput(1);
    expect(() => Manifest.create({ ...bad, candidates: [{ ...(bad.candidates[0] as (typeof bad.candidates)[number]), path: "relative" }] })).toThrow(QuarantineError);
  });

  it("rejects a bad plan digest, an unknown detector and a non-integer size", () => {
    expect(() => newManifest(1, { planDigest: "xyz" })).toThrow(QuarantineError);
    const bad = manifestInput(1);
    const c = bad.candidates[0] as (typeof bad.candidates)[number];
    expect(() => Manifest.create({ ...bad, candidates: [{ ...c, detector: "nope" as never }] })).toThrow(QuarantineError);
    expect(() => Manifest.create({ ...bad, candidates: [{ ...c, size: 1.5 }] })).toThrow(QuarantineError);
  });

  it("rejects duplicate stored names and duplicate indexes", () => {
    const body = newManifest(2).toBody();
    const dupStored: ManifestBody = { ...body, entries: [body.entries[0]!, { ...body.entries[1]!, stored: "0001" }] };
    expect(() => Manifest.fromBody(dupStored)).toThrow("manifest has duplicate stored names");
    const dupIndex: ManifestBody = { ...body, entries: [body.entries[0]!, { ...body.entries[1]!, index: 1 }] };
    expect(() => Manifest.fromBody(dupIndex)).toThrow("manifest has duplicate entry indexes");
  });

  it("rejects unknown keys in the body", () => {
    const body = { ...newManifest(1).toBody(), extra: 1 } as unknown as ManifestBody;
    expect(() => Manifest.fromBody(body)).toThrow(/unknown key/);
  });

  it("toBody returns a copy: editing it does not change the manifest", () => {
    const m = newManifest(1);
    const body = m.toBody();
    (body.entries[0] as { size: number }).size = 999;
    expect(m.entries[0]?.size).toBe(4096);
  });

  it("validates ids and stored names", () => {
    expect(() => assertPlanId(PLAN_ID)).not.toThrow();
    expect(() => assertPlanId("../etc")).toThrow("invalid plan id");
    expect(() => assertStoredName("0001")).not.toThrow();
    expect(() => assertStoredName("../../x")).toThrow("invalid stored item name");
    expect(() => assertStoredName("001")).toThrow(QuarantineError);
    expect(storedName(7)).toBe("0007");
    expect(storedName(12345)).toBe("12345");
  });
});

describe("Manifest lifecycle transitions", () => {
  it("pending -> quarantined records quarantinedAt and leaves the original untouched (values are immutable)", () => {
    const m = newManifest(2);
    const q = m.markQuarantined(1, 7_000);
    expect(q.entry(1)).toMatchObject({ status: "quarantined", quarantinedAt: 7_000 });
    expect(q.entry(2)?.status).toBe("pending");
    expect(m.entry(1)?.status).toBe("pending");
  });

  it("quarantined -> purged records purgedAt", () => {
    const m = newManifest(1).markQuarantined(1, 10).markPurged(1, 99);
    expect(m.entry(1)).toMatchObject({ status: "purged", quarantinedAt: 10, purgedAt: 99 });
  });

  it("pending and quarantined entries can be restored; restoredAt is recorded", () => {
    expect(newManifest(1).markRestored(1, 5).entry(1)).toMatchObject({ status: "restored", restoredAt: 5 });
    expect(newManifest(1).markQuarantined(1, 1).markRestored(1, 5).entry(1)).toMatchObject({ status: "restored", quarantinedAt: 1, restoredAt: 5 });
  });

  it("rollback undoes a quarantined entry but is refused for a pending one", () => {
    const q = newManifest(1).markQuarantined(1, 1);
    expect(q.rollback(1, 2).entry(1)).toMatchObject({ status: "restored", restoredAt: 2 });
    expect(() => newManifest(1).rollback(1, 2)).toThrow(IllegalTransitionError);
  });

  it.each([
    ["quarantine twice", (m: Manifest) => m.markQuarantined(1, 1).markQuarantined(1, 2), "quarantined", "quarantined"],
    ["quarantine a restored entry", (m: Manifest) => m.markRestored(1, 1).markQuarantined(1, 2), "restored", "quarantined"],
    ["quarantine a purged entry", (m: Manifest) => m.markQuarantined(1, 1).markPurged(1, 2).markQuarantined(1, 3), "purged", "quarantined"],
    ["restore a restored entry", (m: Manifest) => m.markRestored(1, 1).markRestored(1, 2), "restored", "restored"],
    ["restore a purged entry", (m: Manifest) => m.markQuarantined(1, 1).markPurged(1, 2).markRestored(1, 3), "purged", "restored"],
    ["purge a pending entry", (m: Manifest) => m.markPurged(1, 1), "pending", "purged"],
    ["purge a restored entry", (m: Manifest) => m.markRestored(1, 1).markPurged(1, 2), "restored", "purged"],
    ["purge twice", (m: Manifest) => m.markQuarantined(1, 1).markPurged(1, 2).markPurged(1, 3), "purged", "purged"],
    ["roll back a restored entry", (m: Manifest) => m.markQuarantined(1, 1).rollback(1, 2).rollback(1, 3), "restored", "restored"],
  ])("refuses to %s", (_name, act, from, to) => {
    let err: unknown;
    try {
      act(newManifest(1));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err).toBeInstanceOf(QuarantineError);
    expect((err as IllegalTransitionError).message).toBe(`entry 0001 cannot go from ${from} to ${to}`);
  });

  it("refuses an unknown entry index and a bad timestamp", () => {
    expect(() => newManifest(1).markQuarantined(9, 1)).toThrow("manifest has no entry 9");
    expect(() => newManifest(1).markQuarantined(1, -1)).toThrow("timestamp must be a non-negative integer");
    expect(() => newManifest(1).markQuarantined(1, 1.5)).toThrow(QuarantineError);
    expect(() => newManifest(1).markQuarantined(1, Number.NaN)).toThrow(QuarantineError);
  });

  it("selects restorable entries: pending and quarantined only", () => {
    const m = newManifest(4).markQuarantined(1, 1).markQuarantined(2, 1).markRestored(2, 2).markQuarantined(3, 1).markPurged(3, 2);
    expect(m.restorable().map((e) => e.index)).toEqual([1, 4]);
    expect(m.restorableAt(`${ROOT}/p1/node_modules`).map((e) => e.index)).toEqual([1]);
    expect(m.restorableAt(`${ROOT}/p2/node_modules`)).toEqual([]);
    expect(m.restorableAt("/nowhere")).toEqual([]);
  });

  it("finds entries by index and by stored name", () => {
    const m = newManifest(2);
    expect(m.entryByStored("0002")?.index).toBe(2);
    expect(m.entryByStored("0009")).toBeUndefined();
    expect(m.entry(3)).toBeUndefined();
  });
});

describe("Manifest purge eligibility", () => {
  const ttl = 7 * DAY_MS;
  const quarantinedAt = 1_000_000;

  it("an entry is eligible exactly at the TTL boundary and not one millisecond earlier", () => {
    const m = newManifest(1).markQuarantined(1, quarantinedAt);
    expect(m.purgeEligible(quarantinedAt + ttl - 1, ttl)).toEqual([]);
    const at = m.purgeEligible(quarantinedAt + ttl, ttl);
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ planId: PLAN_ID, ageDays: 7 });
    expect(at[0]?.entry.stored).toBe("0001");
  });

  it("ageDays is the whole number of days in quarantine", () => {
    const m = newManifest(1).markQuarantined(1, 0);
    expect(m.purgeEligible(10 * DAY_MS + DAY_MS - 1, ttl)[0]?.ageDays).toBe(10);
    expect(m.purgeEligible(0, 0)[0]?.ageDays).toBe(0);
  });

  it("a zero TTL makes every quarantined entry eligible but never a pending, restored or purged one", () => {
    const m = newManifest(4).markQuarantined(1, 5).markQuarantined(2, 5).markRestored(2, 6).markQuarantined(3, 5).markPurged(3, 6);
    expect(m.purgeEligible(100, 0).map((i) => i.entry.index)).toEqual([1]);
  });

  it("an entry quarantined in the future is not eligible", () => {
    const m = newManifest(1).markQuarantined(1, 1000);
    expect(m.purgeEligible(999, 0)).toEqual([]);
  });

  it("purgeAgeMs is null unless the entry is quarantined with a timestamp", () => {
    const m = newManifest(1);
    expect(purgeAgeMs(m.entry(1)!, 10)).toBeNull();
    expect(purgeAgeMs(m.markQuarantined(1, 4).entry(1)!, 10)).toBe(6);
    const forged = { ...m.entry(1)!, status: "quarantined" as const };
    expect(purgeAgeMs(forged, 10)).toBeNull();
  });
});

describe("purgeSetDigest", () => {
  const item = (planId: string, stored: string) => ({ planId, entry: { stored } });
  const a = item(PLAN_ID, "0001");
  const b = item(PLAN_ID, "0002");
  const c = item("plan-20260102T000000Z-bbbbbbbb", "0001");

  it("is a sha256 hex digest, independent of order, and depends on the set", () => {
    const d = purgeSetDigest([a, b, c]);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(purgeSetDigest([c, a, b])).toBe(d);
    expect(purgeSetDigest([a, b])).not.toBe(d);
    expect(purgeSetDigest([])).not.toBe(d);
    expect(purgeSetDigest([a, b, c])).toBe(d);
  });

  it("distinguishes plan id from stored name", () => {
    expect(purgeSetDigest([item("plan-20260102T000000Z-bbbbbbbb", "0001")])).not.toBe(purgeSetDigest([item("plan-20260102T000000Z-bbbbbbbc", "0001")]));
  });

  it("does not depend on ages or other entry fields", () => {
    const m = newManifest(2).markQuarantined(1, 1).markQuarantined(2, 1);
    const items = m.purgeEligible(100 * DAY_MS, 0);
    expect(purgeSetDigest(items)).toBe(purgeSetDigest(items.map((i) => ({ ...i, ageDays: 999 }))));
  });
});

describe("Manifest seal and authentication", () => {
  const signer = fakeSigner("k1");

  it("a sealed manifest opens again and equals the original", () => {
    const m = newManifest(3).markQuarantined(1, 10).markQuarantined(2, 11);
    const text = JSON.stringify(m.seal(signer));
    const opened = Manifest.open(text, PLAN_ID, signer);
    expect(opened.toBody()).toEqual(m.toBody());
  });

  it("the seal covers the exact MAC input of the stored format (domain prefix + canonical JSON, no mac)", () => {
    let seen = "";
    const record = newManifest(1).seal({ sign: (msg) => ((seen = msg), "a".repeat(64)) });
    expect(record.mac).toBe("a".repeat(64));
    expect(seen.startsWith("disk-janitor/manifest/v1\n{")).toBe(true);
    expect(seen).toContain('"entries":[{"detector":"node-modules"');
    expect(seen).not.toContain("mac");
    expect(seen).not.toContain(" ");
  });

  it("rejects a manifest sealed with another key", () => {
    const text = JSON.stringify(newManifest(1).seal(fakeSigner("other")));
    expect(() => Manifest.open(text, PLAN_ID, signer)).toThrow("manifest signature is invalid: it was modified");
  });

  it("cannot be authenticated without a key", () => {
    const text = JSON.stringify(newManifest(1).seal(signer));
    expect(() => Manifest.open(text, PLAN_ID, null)).toThrow("approval key missing: cannot authenticate manifest");
  });

  it("rejects a manifest that belongs to a different plan, even with a valid seal", () => {
    const text = JSON.stringify(newManifest(1).seal(signer));
    expect(() => Manifest.open(text, "plan-20260101T000000Z-bbbbbbbb", signer)).toThrow("manifest belongs to a different plan");
  });

  it("rejects text that is not JSON, not an object, or has unknown keys", () => {
    expect(() => Manifest.open("{", PLAN_ID, signer)).toThrow(/not valid JSON/);
    expect(() => Manifest.open("[]", PLAN_ID, signer)).toThrow(QuarantineError);
    const rec = { ...newManifest(1).seal(signer), extra: true };
    expect(() => Manifest.open(JSON.stringify(rec), PLAN_ID, signer)).toThrow(/unknown key/);
  });

  it("rejects text larger than the size limit", () => {
    expect(() => Manifest.open(" ".repeat(8 * 1024 * 1024 + 1), PLAN_ID, signer)).toThrow(/larger than/);
  });

  it("a stored name that points outside the items directory fails the schema", () => {
    const text = JSON.stringify(newManifest(1).seal(signer)).replace('"0001"', '"../x"');
    expect(() => Manifest.open(text, PLAN_ID, signer)).toThrow(/entries\[0\]\.stored: does not match the required format/);
  });

  it("tampering with any single field of the stored record is detected", () => {
    const m = newManifest(2).markQuarantined(1, 10);
    const base = m.seal(signer) as unknown as Record<string, unknown>;
    const mutate = (path: Array<string | number>, to: unknown) => {
      const copy = structuredClone(base);
      let cur = copy as Record<string | number, unknown>;
      for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
      cur[path[path.length - 1] as string | number] = to;
      return JSON.stringify(copy);
    };
    const cases: Array<[string, Array<string | number>, unknown]> = [
      ["planDigest", ["planDigest"], "e".repeat(64)],
      ["createdAt", ["createdAt"], 5_001],
      ["roots", ["roots", 0], "/home/u/other"],
      ["home", ["home"], "/home/v"],
      ["detectors", ["detectors", 0], "package-cache"],
      ["entry.originalPath", ["entries", 0, "originalPath"], "/home/u/projects/evil"],
      ["entry.detector", ["entries", 0, "detector"], "build-output"],
      ["entry.dev", ["entries", 0, "dev"], "101"],
      ["entry.ino", ["entries", 0, "ino"], "1"],
      ["entry.size", ["entries", 0, "size"], 1],
      ["entry.mtimeMs", ["entries", 0, "mtimeMs"], 1],
      ["entry.status", ["entries", 0, "status"], "pending"],
      ["entry.quarantinedAt", ["entries", 0, "quarantinedAt"], 11],
      ["entry.index", ["entries", 1, "index"], 7],
      ["entry.stored", ["entries", 1, "stored"], "0009"],
      ["mac", ["mac"], "f".repeat(64)],
    ];
    for (const [name, path, to] of cases) {
      expect(() => Manifest.open(mutate(path, to), PLAN_ID, signer), name).toThrow(QuarantineError);
    }
  });

  it("property: random single-field mutations of a sealed manifest are always detected", () => {
    const next = rng(20240607);
    const m = newManifest(4)
      .markQuarantined(1, 10)
      .markQuarantined(2, 11)
      .markRestored(2, 12)
      .markQuarantined(3, 13)
      .markPurged(3, 14);
    const record = m.seal(signer);
    const leaves: Array<Array<string | number>> = [];
    const walk = (v: unknown, path: Array<string | number>) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      else leaves.push(path);
    };
    walk(record, []);
    for (let n = 0; n < 300; n++) {
      const copy = structuredClone(record) as unknown as Record<string | number, unknown>;
      const path = leaves[Math.floor(next() * leaves.length)] as Array<string | number>;
      let cur = copy;
      for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
      const key = path[path.length - 1] as string | number;
      const old = cur[key];
      const mode = next();
      if (mode < 0.2) delete cur[key];
      else if (typeof old === "number") cur[key] = old + 1 + Math.floor(next() * 5);
      else if (typeof old === "string") cur[key] = old.length > 0 ? old.slice(0, -1) + (old.endsWith("0") ? "1" : "0") : "x";
      else cur[key] = null;
      expect(() => Manifest.open(JSON.stringify(copy), PLAN_ID, signer), `mutation of ${path.join(".")}`).toThrow(QuarantineError);
    }
  });
});

describe("Manifest property: sequences of legal transitions keep the invariants", () => {
  type Op = "quarantine" | "restore" | "rollback" | "purge";
  const legal: Record<Op, string[]> = { quarantine: ["pending"], restore: ["pending", "quarantined"], rollback: ["quarantined"], purge: ["quarantined"] };

  it("random legal sequences preserve identity, uniqueness, timestamps and never resurrect a purged entry", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = rng(seed);
      let m = newManifest(5);
      const identity = m.entries.map((e) => [e.index, e.stored, e.originalPath, e.dev, e.ino, e.size, e.mtimeMs]);
      let clock = 1;
      const purged = new Set<number>();
      for (let step = 0; step < 60; step++) {
        const index = 1 + Math.floor(next() * 5);
        const op = (["quarantine", "restore", "rollback", "purge"] as const)[Math.floor(next() * 4)] as Op;
        const status = (m.entry(index) as { status: string }).status;
        clock += 1 + Math.floor(next() * 10);
        const attempt = () => (op === "quarantine" ? m.markQuarantined(index, clock) : op === "restore" ? m.markRestored(index, clock) : op === "rollback" ? m.rollback(index, clock) : m.markPurged(index, clock));
        if (legal[op].includes(status)) {
          m = attempt();
          if (op === "purge") purged.add(index);
        } else {
          expect(attempt).toThrow(IllegalTransitionError);
        }
        // invariants after every step
        expect(m.entries.map((e) => [e.index, e.stored, e.originalPath, e.dev, e.ino, e.size, e.mtimeMs])).toEqual(identity);
        expect(new Set(m.entries.map((e) => e.stored)).size).toBe(5);
        for (const e of m.entries) {
          if (e.status === "pending") expect([e.quarantinedAt, e.restoredAt, e.purgedAt]).toEqual([undefined, undefined, undefined]);
          if (e.status === "quarantined") expect(e.quarantinedAt).toBeDefined();
          if (e.status === "restored") expect(e.restoredAt).toBeDefined();
          if (e.status === "purged") expect(e.purgedAt).toBeDefined();
          if (purged.has(e.index)) expect(e.status).toBe("purged");
        }
        // a transition never leaves an unsealable manifest
        expect(Manifest.open(JSON.stringify(m.seal(fakeSigner())), PLAN_ID, fakeSigner()).toBody()).toEqual(m.toBody());
      }
    }
  });
});

describe("Manifest input from the world", () => {
  it("fromBody validates before wrapping", () => {
    const body = newManifest(1).toBody();
    expect(() => Manifest.fromBody({ ...body, version: 2 as never })).toThrow(QuarantineError);
    expect(Manifest.fromBody(body).planId).toBe(PLAN_ID);
  });
});
