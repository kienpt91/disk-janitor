// Domain events. Aggregates and use cases emit them; an EventPublisher port delivers them (the
// infrastructure adapter appends them to the hash-chained audit log). Names and payloads are the
// audit log's vocabulary, so the log reads like the ubiquitous language (see docs/domain.md).

export interface DomainEvent {
  readonly name: EventName;
  readonly data: Readonly<Record<string, unknown>>;
}

export const EVENT_NAMES = [
  "plan-created",
  "approval-issued",
  "approval-declined",
  "approval-consumed",
  "apply-refused",
  "apply-start",
  "apply-aborted",
  "quarantine-begin",
  "quarantine-done",
  "rollback",
  "rollback-failed",
  "apply-complete",
  "docker-prune-begin",
  "docker-prune-done",
  "restore-begin",
  "restore-done",
  "restore-refused",
  "restore-failed",
  "purge-begin",
  "purge-done",
  "purge-failed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const ev = (name: EventName, data: Record<string, unknown>): DomainEvent => ({ name, data });

export const events = {
  planCreated: (d: { planId: string; planDigest: string; candidates: number; path: string }) => ev("plan-created", d),
  approvalIssued: (d: { planId: string; planDigest: string; expiresAt: number; nonce: string; approver: string }) => ev("approval-issued", d),
  approvalDeclined: (d: { planId: string; planDigest: string; approver: string }) => ev("approval-declined", d),
  approvalConsumed: (d: { planId: string; planDigest: string; nonce: string }) => ev("approval-consumed", d),
  applyRefused: (d: { planId: string; planDigest: string; reason: string }) => ev("apply-refused", d),
  applyStarted: (d: { planId: string; planDigest: string; fs: number }) => ev("apply-start", d),
  applyAborted: (d: { planId: string; reason: string; path?: string; problems?: string[]; undone?: boolean }) => ev("apply-aborted", d),
  quarantineBegan: (d: { planId: string; id: string; path: string; size: number }) => ev("quarantine-begin", d),
  quarantineDone: (d: { planId: string; id: string; path: string; size: number }) => ev("quarantine-done", d),
  rolledBack: (d: { planId: string; path: string }) => ev("rollback", d),
  rollbackFailed: (d: { planId: string; path: string }) => ev("rollback-failed", d),
  applyCompleted: (d: { planId: string; moved: number; docker: number }) => ev("apply-complete", d),
  dockerPruneBegan: (d: { planId: string; resource: string }) => ev("docker-prune-begin", d),
  dockerPruneDone: (d: { planId: string; resource: string; ok: boolean; detail: string }) => ev("docker-prune-done", d),
  restoreBegan: (d: { planId: string; path: string }) => ev("restore-begin", d),
  restoreDone: (d: { planId: string; path: string }) => ev("restore-done", d),
  restoreRefused: (d: { planId: string; path: string; reason: string }) => ev("restore-refused", d),
  restoreFailed: (d: { planId: string; path: string; reason: string }) => ev("restore-failed", d),
  purgeBegan: (d: { planId: string; stored: string; path: string; size: number }) => ev("purge-begin", d),
  purgeDone: (d: { planId: string; stored: string; path: string }) => ev("purge-done", d),
  purgeFailed: (d: { planId: string; stored: string; reason: string }) => ev("purge-failed", d),
} as const;
