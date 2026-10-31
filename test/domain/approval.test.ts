import { describe, expect, it } from "vitest";
import { Approval, constantTimeEqual, DEFAULT_VALIDITY_MS, MAX_APPROVAL_BYTES, MAX_VALIDITY_MS, type ApprovalRecord, type Signer } from "../../src/domain/approval/approval.js";
import { sha256Hex } from "../../src/domain/shared/canonical.js";

// A pure, deterministic signer: no key material, no fs.
const signerFor = (key: string): Signer => ({ sign: (m) => sha256Hex(`${key}\n${m}`) });
const signer = signerFor("k1");

const plan = { id: "plan-20260101T000000Z-00000001", digest: "a".repeat(64) };
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = Date.UTC(2026, 0, 1, 12);
const MIN = 60_000;

const issue = (over: { now?: number; validity?: number; nonce?: string; signer?: Signer; plan?: typeof plan } = {}) =>
  Approval.issue(over.plan ?? plan, over.now ?? NOW, over.validity ?? DEFAULT_VALIDITY_MS, over.nonce ?? NONCE, over.signer ?? signer);

const text = (r: Record<string, unknown>) => JSON.stringify(r);
const never = () => false;

/** Sign an arbitrary record the way the domain does, to reach checks that issue() itself prevents. */
function forge(fields: Partial<Omit<ApprovalRecord, "mac">> = {}, s: Signer = signer): ApprovalRecord {
  const body = { version: 1 as const, purpose: "apply" as const, planId: plan.id, planDigest: plan.digest, issuedAt: NOW, expiresAt: NOW + MIN, nonce: NONCE, ...fields };
  const input = ["disk-janitor/approval/v1", body.purpose, body.planId, body.planDigest, String(body.issuedAt), String(body.expiresAt), body.nonce].join("\n");
  return { ...body, mac: s.sign(input) };
}

function reason(t: string, p = plan, now = NOW, s: Signer | null = signer, consumed: (n: string) => boolean = never): string {
  const r = Approval.verify(t, p, now, s, consumed);
  if (r.ok) throw new Error("expected approval to be refused");
  return r.reason;
}

describe("Approval.issue", () => {
  it("fills in every record field", () => {
    const a = issue();
    expect(a.record).toEqual({
      version: 1,
      purpose: "apply",
      planId: plan.id,
      planDigest: plan.digest,
      issuedAt: NOW,
      expiresAt: NOW + DEFAULT_VALIDITY_MS,
      nonce: NONCE,
      mac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(a.nonce).toBe(NONCE);
    expect(a.expiresAt).toBe(NOW + DEFAULT_VALIDITY_MS);
  });

  it("the default validity is 15 minutes and the maximum is 60", () => {
    expect(DEFAULT_VALIDITY_MS).toBe(15 * MIN);
    expect(MAX_VALIDITY_MS).toBe(60 * MIN);
  });

  it.each([1, 1000, 5 * MIN, MAX_VALIDITY_MS])("accepts a validity of %i ms", (v) => {
    expect(issue({ validity: v }).expiresAt).toBe(NOW + v);
  });

  it.each([0, -1, -MIN, MAX_VALIDITY_MS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])("rejects a validity of %s", (v) => {
    expect(() => issue({ validity: v })).toThrow("approval validity must be between 1 ms and 60 minutes");
  });

  it.each(["", "0123", NONCE.slice(1), NONCE + "0", NONCE.toUpperCase(), "g".repeat(32), " ".repeat(32), NONCE.slice(0, 31) + "\n"])("rejects the nonce %j", (n) => {
    expect(() => issue({ nonce: n })).toThrow("approval nonce must be 32 hex characters");
  });

  it("its record is accepted by verify with the same signer", () => {
    const a = issue();
    const r = Approval.verify(text(a.record), plan, NOW + 1, signer, never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approval.record).toEqual(a.record);
  });

  it("is deterministic for the same inputs and differs when the key differs", () => {
    expect(issue().record.mac).toBe(issue().record.mac);
    expect(issue({ signer: signerFor("k2") }).record.mac).not.toBe(issue().record.mac);
  });

  it("a different nonce, time or plan gives a different mac", () => {
    const base = issue().record.mac;
    expect(issue({ nonce: "f".repeat(32) }).record.mac).not.toBe(base);
    expect(issue({ now: NOW + 1 }).record.mac).not.toBe(base);
    expect(issue({ plan: { ...plan, digest: "b".repeat(64) } }).record.mac).not.toBe(base);
    expect(issue({ plan: { ...plan, id: "plan-20260101T000000Z-00000002" } }).record.mac).not.toBe(base);
    expect(issue({ validity: MIN }).record.mac).not.toBe(base);
  });
});

describe("Approval.verify: MAC binds every field", () => {
  const record = issue().record;
  const tamper: Array<[keyof ApprovalRecord, unknown]> = [
    ["issuedAt", NOW - 1],
    ["expiresAt", NOW + DEFAULT_VALIDITY_MS + 1],
    ["nonce", "f".repeat(32)],
    ["mac", record.mac.replace(/^./, (c) => (c === "0" ? "1" : "0"))],
  ];

  it.each(tamper)("changing %s makes verification fail", (key, value) => {
    const r = reason(text({ ...record, [key]: value }));
    expect(r).toBe("approval signature is invalid");
  });

  it("changing the plan id or digest in the record, with the plan changed to match, still fails the signature", () => {
    const otherDigest = { ...plan, digest: "b".repeat(64) };
    expect(reason(text({ ...record, planDigest: otherDigest.digest }), otherDigest)).toBe("approval signature is invalid");
    const otherId = { ...plan, id: "plan-20260101T000000Z-0000000f" };
    expect(reason(text({ ...record, planId: otherId.id }), otherId)).toBe("approval signature is invalid");
  });

  it("the fields are not interchangeable: swapping issuedAt and expiresAt fails", () => {
    expect(reason(text({ ...record, issuedAt: record.expiresAt, expiresAt: record.issuedAt }))).toBe("approval signature is invalid");
  });

  it("a record signed by another key is refused", () => {
    expect(reason(text(issue({ signer: signerFor("k2") }).record))).toBe("approval signature is invalid");
  });

  it("an uppercase mac is not accepted (schema)", () => {
    expect(reason(text({ ...record, mac: record.mac.toUpperCase() }))).toMatch(/^approval record invalid: /);
  });
});

describe("Approval.verify reasons", () => {
  const good = text(issue().record);

  it("accepts a fresh approval and returns the parsed record", () => {
    const r = Approval.verify(good, plan, NOW, signer, never);
    expect(r.ok).toBe(true);
  });

  describe("schema", () => {
    it.each([
      ["not JSON", "{"],
      ["an array", "[]"],
      ["null", "null"],
      ["an empty object", "{}"],
    ])("rejects %s", (_n, t) => {
      expect(reason(t)).toMatch(/^approval record invalid: approval: /);
    });

    it("rejects an unknown extra key", () => {
      expect(reason(text({ ...issue().record, extra: true }))).toBe("approval record invalid: approval: extra: unknown key");
    });

    it("rejects a missing field", () => {
      const { nonce: _n, ...rest } = issue().record;
      expect(reason(text(rest))).toBe("approval record invalid: approval: nonce: required");
    });

    it.each([
      ["version", 2],
      ["purpose", "restore"],
      ["issuedAt", "now"],
      ["issuedAt", 1.5],
      ["expiresAt", -1],
      ["nonce", "xyz"],
      ["planDigest", "abc"],
      ["planId", "p".repeat(65)],
      ["mac", "short"],
    ])("rejects a bad %s (%j)", (key, value) => {
      expect(reason(text({ ...issue().record, [key]: value }))).toMatch(/^approval record invalid: /);
    });

    it("rejects text larger than the size limit", () => {
      const big = text({ ...issue().record, planId: "x".repeat(MAX_APPROVAL_BYTES) });
      expect(reason(big)).toBe(`approval record invalid: approval: larger than ${MAX_APPROVAL_BYTES} bytes`);
    });
  });

  it("refuses an approval issued for a different plan digest", () => {
    expect(reason(good, { ...plan, digest: "b".repeat(64) })).toBe("approval was issued for a different plan");
  });

  it("refuses an approval issued for a different plan id", () => {
    expect(reason(good, { ...plan, id: "plan-20260101T000000Z-00000002" })).toBe("approval was issued for a different plan");
  });

  it("the plan binding is checked before the key", () => {
    expect(reason(good, { ...plan, digest: "b".repeat(64) }, NOW, null)).toBe("approval was issued for a different plan");
  });

  it("refuses when no key exists", () => {
    expect(reason(good, plan, NOW, null)).toBe("no approval key exists");
  });

  it("refuses a bad signature", () => {
    expect(reason(good, plan, NOW, signerFor("other"))).toBe("approval signature is invalid");
  });

  describe("validity window (signed records that issue() would never create)", () => {
    it("refuses a window longer than 60 minutes", () => {
      expect(reason(text(forge({ expiresAt: NOW + MAX_VALIDITY_MS + 1 })))).toBe("approval has an invalid validity window");
    });

    it("accepts a window of exactly 60 minutes", () => {
      expect(Approval.verify(text(forge({ expiresAt: NOW + MAX_VALIDITY_MS })), plan, NOW, signer, never).ok).toBe(true);
    });

    it("refuses a window of zero length", () => {
      expect(reason(text(forge({ expiresAt: NOW })))).toBe("approval has an invalid validity window");
    });

    it("refuses a negative window", () => {
      expect(reason(text(forge({ expiresAt: NOW - 1 })))).toBe("approval has an invalid validity window");
    });
  });

  describe("clock", () => {
    it("tolerates an issue time up to 60 seconds in the future", () => {
      const t = text(forge({ issuedAt: NOW + 60_000, expiresAt: NOW + 60_000 + MIN }));
      expect(Approval.verify(t, plan, NOW, signer, never).ok).toBe(true);
    });

    it("refuses an issue time more than 60 seconds in the future", () => {
      const t = text(forge({ issuedAt: NOW + 60_001, expiresAt: NOW + 60_001 + MIN }));
      expect(reason(t)).toBe("approval is dated in the future");
    });

    it("is valid one millisecond before expiry", () => {
      const a = issue({ validity: MIN });
      expect(Approval.verify(text(a.record), plan, a.expiresAt - 1, signer, never).ok).toBe(true);
    });

    it("is expired exactly at expiresAt", () => {
      const a = issue({ validity: MIN });
      expect(reason(text(a.record), plan, a.expiresAt)).toBe("approval has expired");
    });

    it("stays expired afterwards", () => {
      const a = issue({ validity: MIN });
      expect(reason(text(a.record), plan, a.expiresAt + 10 * MIN)).toBe("approval has expired");
    });

    it("a 1 ms approval expires one millisecond later", () => {
      const a = issue({ validity: 1 });
      expect(Approval.verify(text(a.record), plan, NOW, signer, never).ok).toBe(true);
      expect(reason(text(a.record), plan, NOW + 1)).toBe("approval has expired");
    });
  });

  describe("single use", () => {
    it("refuses a nonce that has been consumed and passes the nonce to the callback", () => {
      const seen: string[] = [];
      const r = reason(good, plan, NOW, signer, (n) => (seen.push(n), true));
      expect(r).toBe("approval was already used");
      expect(seen).toEqual([NONCE]);
    });

    it("does not ask about consumption when an earlier check already failed", () => {
      let asked = 0;
      reason(good, plan, NOW + DEFAULT_VALIDITY_MS, signer, () => (asked++, true));
      expect(asked).toBe(0);
    });

    it("accepts when only other nonces were consumed", () => {
      expect(Approval.verify(good, plan, NOW, signer, (n) => n === "f".repeat(32)).ok).toBe(true);
    });
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings, including empty ones", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("is false when lengths differ", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });

  it("is false for a difference in any position", () => {
    const a = "0123456789abcdef";
    for (let i = 0; i < a.length; i++) {
      const b = a.slice(0, i) + (a[i] === "x" ? "y" : "x") + a.slice(i + 1);
      expect(constantTimeEqual(a, b)).toBe(false);
    }
  });

  it("is case sensitive", () => {
    expect(constantTimeEqual("abc", "ABC")).toBe(false);
  });

  it("distinguishes characters whose codes share low bits", () => {
    expect(constantTimeEqual("a", "\u0161")).toBe(false);
    expect(constantTimeEqual("\u0100", "\u0000")).toBe(false);
  });
});
