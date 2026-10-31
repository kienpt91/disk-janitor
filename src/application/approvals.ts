import { Approval, DEFAULT_VALIDITY_MS, type ApprovalCheck, type ApprovalRecord } from "../domain/approval/approval.js";
import { isApprovalConsumed } from "../domain/audit/chain.js";
import { events } from "../domain/events.js";
import type { Plan } from "../domain/model/types.js";
import type { Approver } from "./approvers.js";
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

export type ApprovePlanResult = { approved: true; record: ApprovalRecord } | { approved: false };

/**
 * ApprovePlan use case: the human step. The approver (terminal prompt or OS dialog) decides after
 * showing the plan; an approved decision issues the single-use record. Publishes `approval-issued`
 * or `approval-declined`, each with the approver kind.
 */
export async function approvePlan(ports: ApprovePlanPorts, approver: Approver, plan: Plan, validityMs: number): Promise<ApprovePlanResult> {
  approver.preflight?.();
  if (isPlanTooOld(plan, ports.clock.now())) throw new PlanTooOldError();
  const decision = await approver.decide(plan, validityMs);
  if (decision !== "approved") {
    await ports.events.publish(events.approvalDeclined({ planId: plan.id, planDigest: plan.digest, approver: approver.kind }));
    return { approved: false };
  }
  const record = await issueApproval(ports, plan, validityMs);
  await ports.events.publish(
    events.approvalIssued({ planId: plan.id, planDigest: plan.digest, expiresAt: record.expiresAt, nonce: record.nonce, approver: approver.kind }),
  );
  return { approved: true, record };
}
