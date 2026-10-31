import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditLog } from "./audit.js";
import { safeJson } from "./escape.js";
import { int, literal, obj, parseJson, SchemaError, str } from "./schema.js";
import { loadKey, type State } from "./state.js";
import type { Plan } from "./types.js";

export const DEFAULT_VALIDITY_MS = 15 * 60_000;
export const MAX_VALIDITY_MS = 60 * 60_000;
const MAX_APPROVAL_BYTES = 4096;
const HEX64 = /^[0-9a-f]{64}$/;

export type Purpose = "apply";

const approvalParser = obj({
  version: literal(1),
  purpose: literal("apply"),
  planId: str({ max: 64 }),
  planDigest: str({ pattern: HEX64 }),
  issuedAt: int(),
  expiresAt: int(),
  nonce: str({ pattern: /^[0-9a-f]{32}$/ }),
  mac: str({ pattern: HEX64 }),
});

export type ApprovalRecord = ReturnType<typeof approvalParser>;

function macInput(r: Omit<ApprovalRecord, "mac">): string {
  return ["disk-janitor/approval/v1", r.purpose, r.planId, r.planDigest, String(r.issuedAt), String(r.expiresAt), r.nonce].join("\n");
}

export function approvalPath(state: State, planDigest: string): string {
  if (!HEX64.test(planDigest)) throw new Error("invalid plan digest");
  return join(state.approvalsDir, `${planDigest}.json`);
}

/**
 * Write a short-lived approval record: HMAC-SHA256 over (plan digest, expiry, ...) with the
 * per-user key. The CLI `approve` command calls this only after the interactive human checks;
 * no MCP tool and no other command can create one.
 */
export async function issueApproval(
  state: State,
  plan: Plan,
  nowMs: number,
  validityMs: number = DEFAULT_VALIDITY_MS,
): Promise<ApprovalRecord> {
  if (!Number.isSafeInteger(validityMs) || validityMs <= 0 || validityMs > MAX_VALIDITY_MS) {
    throw new Error(`approval validity must be between 1 ms and ${MAX_VALIDITY_MS / 60_000} minutes`);
  }
  const key = await loadKey(state, true);
  if (!key) throw new Error("could not load the approval key");
  const body = {
    version: 1 as const,
    purpose: "apply" as const,
    planId: plan.id,
    planDigest: plan.digest,
    issuedAt: nowMs,
    expiresAt: nowMs + validityMs,
    nonce: randomBytes(16).toString("hex"),
  };
  const mac = createHmac("sha256", key).update(macInput(body)).digest("hex");
  const record: ApprovalRecord = { ...body, mac };
  const target = approvalPath(state, plan.digest);
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, safeJson(record, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, target);
  return record;
}

export type ApprovalCheck = { ok: true; record: ApprovalRecord } | { ok: false; reason: string };

/** Verify the approval record for exactly this plan: schema, digest binding, MAC, expiry, not consumed. */
export async function verifyApproval(state: State, plan: Plan, nowMs: number, audit: AuditLog): Promise<ApprovalCheck> {
  let text: string;
  try {
    text = await readFile(approvalPath(state, plan.digest), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "no human approval exists for this plan digest" };
    return { ok: false, reason: "approval record unreadable" };
  }
  let record: ApprovalRecord;
  try {
    record = parseJson(text, approvalParser, MAX_APPROVAL_BYTES, "approval");
  } catch (e) {
    return { ok: false, reason: e instanceof SchemaError ? `approval record invalid: ${e.message}` : "approval record invalid" };
  }
  if (record.planDigest !== plan.digest || record.planId !== plan.id) {
    return { ok: false, reason: "approval was issued for a different plan" };
  }
  const key = await loadKey(state, false);
  if (!key) return { ok: false, reason: "no approval key exists" };
  const expected = createHmac("sha256", key).update(macInput(record)).digest();
  const given = Buffer.from(record.mac, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "approval signature is invalid" };
  }
  if (record.expiresAt - record.issuedAt > MAX_VALIDITY_MS || record.expiresAt <= record.issuedAt) {
    return { ok: false, reason: "approval has an invalid validity window" };
  }
  if (record.issuedAt > nowMs + 60_000) return { ok: false, reason: "approval is dated in the future" };
  if (nowMs >= record.expiresAt) return { ok: false, reason: "approval has expired" };
  const v = await audit.verify();
  for (const e of v.entries) {
    if (e.event === "approval-consumed" && e.data["nonce"] === record.nonce) {
      return { ok: false, reason: "approval was already used" };
    }
  }
  return { ok: true, record };
}

/** Record that an approval was spent (audit first, so a copy of the file cannot be replayed) and remove it. */
export async function consumeApproval(state: State, record: ApprovalRecord, audit: AuditLog): Promise<void> {
  await audit.append("approval-consumed", { planId: record.planId, planDigest: record.planDigest, nonce: record.nonce });
  await unlink(approvalPath(state, record.planDigest)).catch(() => undefined);
}
