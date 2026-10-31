import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalPath, consumeApproval, DEFAULT_VALIDITY_MS, issueApproval, MAX_VALIDITY_MS, verifyApproval } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { buildPlan } from "../src/plan.js";
import { scan } from "../src/scan.js";
import { loadKey } from "../src/state.js";
import { makeSandbox } from "./helpers.js";
import { mixedPlan } from "./helpers-stateplan.js";

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

async function setup() {
  const sb = makeSandbox();
  const p = await mixedPlan(sb);
  const audit = new AuditLog(p.state, () => T0);
  const planB = buildPlan(p.config, await scan(p.config, p.deps), T0);
  return { sb, ...p, audit, planB };
}

function edit(path: string, f: (r: Record<string, unknown>) => void) {
  const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  f(r);
  writeFileSync(path, JSON.stringify(r));
}

const reason = (r: { ok: boolean }) => (r as unknown as { reason: string }).reason;

describe("issueApproval / verifyApproval", () => {
  it("writes <digest>.json with mode 0600 and verifies", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    const path = approvalPath(state, plan.digest);
    expect(path).toBe(`${state.approvalsDir}/${plan.digest}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(rec.planDigest).toBe(plan.digest);
    expect(rec.planId).toBe(plan.id);
    expect(rec.expiresAt - rec.issuedAt).toBe(DEFAULT_VALIDITY_MS);
    expect(rec.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.mac).toMatch(/^[0-9a-f]{64}$/);
    const v = await verifyApproval(state, plan, T0 + 1000, audit);
    expect(v).toEqual({ ok: true, record: rec });
  });

  it("leaves no temp files in the approvals directory", async () => {
    const { state, plan } = await setup();
    await issueApproval(state, plan, T0);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(state.approvalsDir)).toEqual([`${plan.digest}.json`]);
  });

  it("uses a fresh nonce on re-issue", async () => {
    const { state, plan } = await setup();
    const a = await issueApproval(state, plan, T0);
    const b = await issueApproval(state, plan, T0);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("rejects when no approval exists", async () => {
    const { state, plan, audit } = await setup();
    const v = await verifyApproval(state, plan, T0, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/no human approval/);
  });

  it("rejects when no key exists", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(state.keyPath);
    const v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/no approval key/);
    expect(rec.mac).toBeTruthy();
  });

  it("an approval for plan A never verifies plan B", async () => {
    const { state, plan, planB, audit } = await setup();
    await issueApproval(state, plan, T0);
    const v = await verifyApproval(state, planB, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/no human approval/);
  });

  it("rejects an approval record copied to another plan's digest filename", async () => {
    const { state, plan, planB, audit } = await setup();
    await issueApproval(state, plan, T0);
    copyFileSync(approvalPath(state, plan.digest), approvalPath(state, planB.digest));
    const v = await verifyApproval(state, planB, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/different plan/);
  });

  it("rejects a same-digest record whose planId was altered", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    edit(approvalPath(state, plan.digest), (r) => (r["planId"] = "plan-other"));
    const v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(reason(v)).toMatch(/different plan/);
  });
});

describe("forgery", () => {
  it("rejects a random mac", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    edit(approvalPath(state, plan.digest), (r) => (r["mac"] = randomBytes(32).toString("hex")));
    const v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/signature/);
  });

  it("rejects a mac computed with a different key", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    const input = ["disk-janitor/approval/v1", rec.purpose, rec.planId, rec.planDigest, String(rec.issuedAt), String(rec.expiresAt), rec.nonce].join("\n");
    // sanity: the same input with the real key reproduces the genuine mac
    const key = (await loadKey(state, false)) as Buffer;
    expect(createHmac("sha256", key).update(input).digest("hex")).toBe(rec.mac);
    const forged = createHmac("sha256", randomBytes(32)).update(input).digest("hex");
    edit(approvalPath(state, plan.digest), (r) => (r["mac"] = forged));
    expect(reason(await verifyApproval(state, plan, T0 + 1, audit))).toMatch(/signature/);
  });

  it("rejects a mac that is just the digest or the nonce (unkeyed)", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    edit(approvalPath(state, plan.digest), (r) => (r["mac"] = plan.digest));
    expect(reason(await verifyApproval(state, plan, T0 + 1, audit))).toMatch(/signature/);
  });

  it("rejects a flipped expiresAt (extended lifetime)", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    edit(approvalPath(state, plan.digest), (r) => (r["expiresAt"] = rec.expiresAt + 60_000));
    expect(reason(await verifyApproval(state, plan, T0 + 1, audit))).toMatch(/signature/);
  });

  it("rejects a flipped issuedAt", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    edit(approvalPath(state, plan.digest), (r) => (r["issuedAt"] = rec.issuedAt + 1));
    expect(reason(await verifyApproval(state, plan, T0 + 5, audit))).toMatch(/signature/);
  });

  it("rejects a changed nonce (so a consumed nonce cannot be dodged)", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    const flipped = (rec.nonce[0] === "a" ? "b" : "a") + rec.nonce.slice(1);
    edit(approvalPath(state, plan.digest), (r) => (r["nonce"] = flipped));
    expect(reason(await verifyApproval(state, plan, T0 + 1, audit))).toMatch(/signature/);
  });

  it("rejects a different purpose and unknown keys as invalid records", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    const path = approvalPath(state, plan.digest);
    edit(path, (r) => (r["purpose"] = "purge"));
    let v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/invalid/);
    await issueApproval(state, plan, T0);
    edit(path, (r) => (r["extra"] = 1));
    v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(reason(v)).toMatch(/unknown key/);
  });

  it("rejects an oversized record and invalid JSON with a reason instead of throwing", async () => {
    const { state, plan, audit } = await setup();
    const path = approvalPath(state, plan.digest);
    writeFileSync(path, "{" + " ".repeat(5000) + "}");
    let v = await verifyApproval(state, plan, T0, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/invalid.*larger than/);
    writeFileSync(path, "not json");
    v = await verifyApproval(state, plan, T0, audit);
    expect(reason(v)).toMatch(/not valid JSON/);
    writeFileSync(path, "[]");
    v = await verifyApproval(state, plan, T0, audit);
    expect(v.ok).toBe(false);
  });

  it("rejects a record whose approval path is a directory (unreadable) without throwing", async () => {
    const { state, plan, audit } = await setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(approvalPath(state, plan.digest));
    const v = await verifyApproval(state, plan, T0, audit);
    expect(v.ok).toBe(false);
  });
});

describe("expiry", () => {
  it("is valid at +14m59s and expired at +15m", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    expect((await verifyApproval(state, plan, T0 + 14 * 60_000 + 59_000, audit)).ok).toBe(true);
    const v = await verifyApproval(state, plan, T0 + 15 * 60_000, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/expired/);
  });

  it("honours a custom validity and rejects 1 ms after it", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0, 5000);
    expect((await verifyApproval(state, plan, T0 + 4999, audit)).ok).toBe(true);
    expect((await verifyApproval(state, plan, T0 + 5000, audit)).ok).toBe(false);
  });

  it("accepts exactly the 60 minute cap and rejects anything above when issuing", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0, MAX_VALIDITY_MS);
    expect((await verifyApproval(state, plan, T0 + MAX_VALIDITY_MS - 1, audit)).ok).toBe(true);
    await expect(issueApproval(state, plan, T0, MAX_VALIDITY_MS + 1)).rejects.toThrow(/between 1 ms and 60 minutes/);
  });

  for (const bad of [0, -1, -60_000, 1.5, Number.NaN, Infinity]) {
    it(`rejects issuing with validity ${bad}`, async () => {
      const { state, plan } = await setup();
      await expect(issueApproval(state, plan, T0, bad)).rejects.toThrow(/validity/);
      expect(existsSync(approvalPath(state, plan.digest))).toBe(false);
    });
  }

  it("rejects, at verify time, a correctly signed record that exceeds the cap", async () => {
    const { state, plan, audit } = await setup();
    const key = (await loadKey(state, true)) as Buffer;
    const body = { version: 1, purpose: "apply", planId: plan.id, planDigest: plan.digest, issuedAt: T0, expiresAt: T0 + MAX_VALIDITY_MS + 1, nonce: "ab".repeat(16) };
    const input = ["disk-janitor/approval/v1", body.purpose, body.planId, body.planDigest, String(body.issuedAt), String(body.expiresAt), body.nonce].join("\n");
    const mac = createHmac("sha256", key).update(input).digest("hex");
    writeFileSync(approvalPath(state, plan.digest), JSON.stringify({ ...body, mac }));
    const v = await verifyApproval(state, plan, T0 + 1, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/invalid validity window/);
  });

  it("rejects a correctly signed record with expiresAt <= issuedAt", async () => {
    const { state, plan, audit } = await setup();
    const key = (await loadKey(state, true)) as Buffer;
    const body = { version: 1, purpose: "apply", planId: plan.id, planDigest: plan.digest, issuedAt: T0, expiresAt: T0, nonce: "cd".repeat(16) };
    const input = ["disk-janitor/approval/v1", body.purpose, body.planId, body.planDigest, String(body.issuedAt), String(body.expiresAt), body.nonce].join("\n");
    writeFileSync(approvalPath(state, plan.digest), JSON.stringify({ ...body, mac: createHmac("sha256", key).update(input).digest("hex") }));
    expect(reason(await verifyApproval(state, plan, T0 - 1, audit))).toMatch(/invalid validity window/);
  });

  it("rejects a future-dated record (beyond 60 s skew) and tolerates small skew", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0 + 5 * 60_000);
    const v = await verifyApproval(state, plan, T0, audit);
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/future/);
    expect((await verifyApproval(state, plan, T0 + 5 * 60_000 - 30_000, audit)).ok).toBe(true);
  });
});

describe("replay", () => {
  it("consume appends approval-consumed, removes the file, and a restored copy is rejected", async () => {
    const { sb, state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    const path = approvalPath(state, plan.digest);
    const backup = `${sb.base}/approval-copy.json`;
    copyFileSync(path, backup);
    expect((await verifyApproval(state, plan, T0 + 1, audit)).ok).toBe(true);
    await consumeApproval(state, rec, audit);
    expect(existsSync(path)).toBe(false);
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    const last = v.entries[v.entries.length - 1];
    expect(last?.event).toBe("approval-consumed");
    expect(last?.data).toEqual({ planId: plan.id, planDigest: plan.digest, nonce: rec.nonce });
    expect((await verifyApproval(state, plan, T0 + 2, audit)).ok).toBe(false);
    copyFileSync(backup, path);
    const replay = await verifyApproval(state, plan, T0 + 3, audit);
    expect(replay.ok).toBe(false);
    expect(reason(replay)).toMatch(/already used/);
  });

  it("a fresh approval for the same plan after consumption is accepted (new nonce)", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    await consumeApproval(state, rec, audit);
    await issueApproval(state, plan, T0 + 10);
    expect((await verifyApproval(state, plan, T0 + 20, audit)).ok).toBe(true);
  });

  it("consume tolerates a missing approval file", async () => {
    const { state, plan, audit } = await setup();
    const rec = await issueApproval(state, plan, T0);
    await consumeApproval(state, rec, audit);
    await expect(consumeApproval(state, rec, audit)).resolves.toBeUndefined();
  });

  it("ignores consumption entries that belong to another nonce", async () => {
    const { state, plan, audit } = await setup();
    await issueApproval(state, plan, T0);
    await audit.append("approval-consumed", { nonce: "0".repeat(32) });
    expect((await verifyApproval(state, plan, T0 + 1, audit)).ok).toBe(true);
  });
});

describe("approvalPath", () => {
  it("rejects a digest that is not 64 lowercase hex characters", async () => {
    const { state } = await setup();
    for (const d of ["", "../x", "A".repeat(64), "a".repeat(63), "a".repeat(64) + "/.."]) {
      expect(() => approvalPath(state, d)).toThrow(/invalid plan digest/);
    }
  });
});
