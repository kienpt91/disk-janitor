import { Approval, DEFAULT_VALIDITY_MS, type ApprovalCheck, type ApprovalRecord } from "../domain/approval/approval.js";
import { isApprovalConsumed } from "../domain/audit/chain.js";
import { events } from "../domain/events.js";
import type { Plan } from "../domain/model/types.js";
import { assertHumanSession, digestPrefix } from "../domain/policy/human.js";
import { confirmByTyping, type HumanIO } from "./human-confirmation.js";
import type { Clock, EventPublisher, IdSource } from "./ports/common.js";
import type { ApprovalStore, AuditTrail, KeyStore } from "./ports/planning.js";
import { isPlanTooOld, PlanTooOldError } from "../domain/plan/plan.js";
import { safeJson } from "../domain/shared/escape.js";

export interface IssueApprovalPorts {
  clock: Clock;
  ids: IdSource;
  keys: KeyStore;
  approvals: ApprovalStore;
}

/** Create and store an approval record for `plan`. Only the human-gated flow below calls this. */
export async function issueApproval(ports: IssueApprovalPorts, plan: Plan, validityMs: number = DEFAULT_VALIDITY_MS): Promise<ApprovalRecord> {
  const signer = await ports.keys.signer(true);
  if (!signer) throw new Error("could not load the approval key");
  const approval = Approval.issue(plan, ports.clock.now(), validityMs, ports.ids.hex(16), signer);
  await ports.approvals.write(plan.digest, safeJson(approval.record, 2) + "\n");
  return approval.record;
}

export type VerifiedApproval = { ok: true; record: ApprovalRecord } | { ok: false; reason: string };

/** Verify the stored approval for exactly this plan: binding, signature, expiry, single use. */
export async function verifyApproval(
  ports: { clock: Clock; keys: KeyStore; approvals: ApprovalStore; audit: AuditTrail },
  plan: Plan,
): Promise<VerifiedApproval> {
  let text: string | null;
  try {
    text = await ports.approvals.read(plan.digest);
  } catch {
    return { ok: false, reason: "approval record unreadable" };
  }
  if (text === null) return { ok: false, reason: "no human approval exists for this plan digest" };
  const signer = await ports.keys.signer(false);
  const verification = await ports.audit.verify();
  const consumed = (nonce: string) => isApprovalConsumed(verification.entries, nonce);
  const check: ApprovalCheck = Approval.verify(text, plan, ports.clock.now(), signer, consumed);
  return check.ok ? { ok: true, record: check.approval.record } : check;
}

/** Record that an approval was spent (audit first, so a copy of the file cannot be replayed) and remove it. */
export async function consumeApproval(ports: { approvals: ApprovalStore; events: EventPublisher }, record: ApprovalRecord): Promise<void> {
  await ports.events.publish(events.approvalConsumed({ planId: record.planId, planDigest: record.planDigest, nonce: record.nonce }));
  await ports.approvals.remove(record.planDigest).catch(() => undefined);
}

export interface ApprovePlanPorts extends IssueApprovalPorts {
  events: EventPublisher;
}

export interface ApprovePlanOptions {
  validityMs: number;
  /** Renders the plan summary shown to the human before the prompt (presentation lives outside). */
  describe: (plan: Plan, validityMs: number) => string[];
}

export type ApprovePlanResult = { approved: true; record: ApprovalRecord } | { approved: false };

/**
 * ApprovePlan use case: the human-only step. Requires an interactive human session, shows the plan,
 * and requires the first 8 characters of the plan digest to be typed back. Publishes
 * `approval-issued` or `approval-declined`.
 */
export async function approvePlan(ports: ApprovePlanPorts, io: HumanIO, plan: Plan, options: ApprovePlanOptions): Promise<ApprovePlanResult> {
  assertHumanSession(io, "approve");
  if (isPlanTooOld(plan, ports.clock.now())) throw new PlanTooOldError();
  for (const line of options.describe(plan, options.validityMs)) io.write(line);
  const ok = await confirmByTyping(io, digestPrefix(plan.digest), "approve this plan (first 8 characters of its digest)");
  if (!ok) {
    await ports.events.publish(events.approvalDeclined({ planId: plan.id, planDigest: plan.digest }));
    return { approved: false };
  }
  const record = await issueApproval(ports, plan, options.validityMs);
  await ports.events.publish(events.approvalIssued({ planId: plan.id, planDigest: plan.digest, expiresAt: record.expiresAt, nonce: record.nonce }));
  return { approved: true, record };
}
