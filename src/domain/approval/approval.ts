import { int, literal, obj, parseJson, SchemaError, str, type Infer } from "../shared/schema.js";
import type { Plan } from "../model/types.js";

export const DEFAULT_VALIDITY_MS = 15 * 60_000;
export const MAX_VALIDITY_MS = 60 * 60_000;
export const MAX_APPROVAL_BYTES = 4096;
const MAX_CLOCK_SKEW_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** Computes the keyed MAC (hex) of a message. The key never enters the domain. */
export interface Signer {
  sign(message: string): string;
}

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

export type ApprovalRecord = Infer<typeof approvalParser>;

export type ApprovalCheck = { ok: true; approval: Approval } | { ok: false; reason: string };

function macInput(r: Omit<ApprovalRecord, "mac">): string {
  return ["disk-janitor/approval/v1", r.purpose, r.planId, r.planDigest, String(r.issuedAt), String(r.expiresAt), r.nonce].join("\n");
}

/** Length-leaking-only comparison that does not short-circuit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A human's authorization to apply exactly one plan. It is bound to the plan digest by a keyed MAC,
 * expires (15 minutes by default, 60 at most) and is single-use: the audit log records the nonce
 * once consumed. Issuing is the only way to create one; the CLI does it after the human checks.
 */
export class Approval {
  private constructor(readonly record: ApprovalRecord) {}

  get nonce(): string {
    return this.record.nonce;
  }

  get expiresAt(): number {
    return this.record.expiresAt;
  }

  /** Issue an approval for `plan`. `nonce` is 32 hex characters from the id source. */
  static issue(plan: Pick<Plan, "id" | "digest">, nowMs: number, validityMs: number, nonce: string, signer: Signer): Approval {
    if (!Number.isSafeInteger(validityMs) || validityMs <= 0 || validityMs > MAX_VALIDITY_MS) {
      throw new Error(`approval validity must be between 1 ms and ${MAX_VALIDITY_MS / 60_000} minutes`);
    }
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("approval nonce must be 32 hex characters");
    const body = {
      version: 1 as const,
      purpose: "apply" as const,
      planId: plan.id,
      planDigest: plan.digest,
      issuedAt: nowMs,
      expiresAt: nowMs + validityMs,
      nonce,
    };
    return new Approval({ ...body, mac: signer.sign(macInput(body)) });
  }

  /**
   * Check an approval record read from storage against `plan`: schema, digest binding, signature,
   * validity window, expiry and not-yet-consumed. `signer` is null when no key exists.
   */
  static verify(
    text: string,
    plan: Pick<Plan, "id" | "digest">,
    nowMs: number,
    signer: Signer | null,
    isConsumed: (nonce: string) => boolean,
  ): ApprovalCheck {
    let record: ApprovalRecord;
    try {
      record = parseJson(text, approvalParser, MAX_APPROVAL_BYTES, "approval");
    } catch (e) {
      return { ok: false, reason: e instanceof SchemaError ? `approval record invalid: ${e.message}` : "approval record invalid" };
    }
    if (record.planDigest !== plan.digest || record.planId !== plan.id) {
      return { ok: false, reason: "approval was issued for a different plan" };
    }
    if (!signer) return { ok: false, reason: "no approval key exists" };
    if (!constantTimeEqual(record.mac, signer.sign(macInput(record)))) {
      return { ok: false, reason: "approval signature is invalid" };
    }
    if (record.expiresAt - record.issuedAt > MAX_VALIDITY_MS || record.expiresAt <= record.issuedAt) {
      return { ok: false, reason: "approval has an invalid validity window" };
    }
    if (record.issuedAt > nowMs + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "approval is dated in the future" };
    if (nowMs >= record.expiresAt) return { ok: false, reason: "approval has expired" };
    if (isConsumed(record.nonce)) return { ok: false, reason: "approval was already used" };
    return { ok: true, approval: new Approval(record) };
  }
}
