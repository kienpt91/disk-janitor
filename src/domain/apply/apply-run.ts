// ApplyRun: the move phase of one Apply. Once every Candidate passed revalidation the run goes
// validated -> moving -> completed, or -> aborted when anything goes wrong, in which case the
// Candidates already moved are rolled back newest first. The run owns the Manifest and the
// bookkeeping; every step returns the domain event the use case must publish, in audit order.
//
//   validated ──beginMove──▶ moving ──(confirmMoved, beginMove)*──▶ moving ──complete──▶ completed
//        │                      │
//        └──────abort───────────┴──abort──▶ aborted ──(rolledBack | rollbackFailed)*

import { events, type DomainEvent } from "../events.js";
import type { FsCandidate } from "../model/types.js";
import { QuarantineError } from "../quarantine/errors.js";
import type { Manifest } from "../quarantine/manifest.js";

export type ApplyPhase = "validated" | "moving" | "completed" | "aborted";

export class ApplyRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyRunStateError";
  }
}

export type AbortReason =
  | { kind: "recheck"; path: string; why: string }
  | { kind: "rename-failed"; path: string; code: string }
  | { kind: "swapped"; path: string; undone: boolean };

export class ApplyRun {
  private current: Manifest;
  private state: ApplyPhase = "validated";
  private inFlight: FsCandidate | null = null;
  /** Candidates moved into Quarantine and not (yet) rolled back, oldest first. */
  private readonly moved: FsCandidate[] = [];
  /** Candidates whose rollback was attempted and failed: they stay in Quarantine. */
  private readonly stuck = new Set<FsCandidate>();
  private nextPosition = 0;

  private constructor(
    private readonly plan: { id: string },
    manifest: Manifest,
    readonly candidates: readonly FsCandidate[],
  ) {
    this.current = manifest;
  }

  /** Start the move phase of a Plan whose Candidates all passed revalidation. */
  static begin(plan: { id: string }, manifest: Manifest, candidates: readonly FsCandidate[]): ApplyRun {
    if (manifest.planId !== plan.id) throw new ApplyRunStateError("the manifest belongs to a different plan");
    if (manifest.entries.length !== candidates.length) throw new ApplyRunStateError("the manifest must have one entry per candidate");
    candidates.forEach((c, i) => {
      const e = manifest.entries[i];
      if (!e || e.originalPath !== c.path || e.status !== "pending") throw new ApplyRunStateError("the manifest entries must be pending and match the candidates in order");
    });
    return new ApplyRun(plan, manifest, candidates);
  }

  get phase(): ApplyPhase {
    return this.state;
  }

  get manifest(): Manifest {
    return this.current;
  }

  /** Candidates currently in Quarantine, oldest first. */
  get movedCandidates(): readonly FsCandidate[] {
    return this.moved;
  }

  /** The stored item name (items/NNNN) of a Candidate of this run. */
  storedNameOf(c: FsCandidate): string {
    return this.entryOf(c).stored;
  }

  /** The Candidate to move next, or undefined when all were moved. */
  get next(): FsCandidate | undefined {
    return this.candidates[this.nextPosition];
  }

  /** About to rename `c` into Quarantine: validated|moving -> moving; emits quarantine-begin. */
  beginMove(c: FsCandidate): DomainEvent {
    if (this.state !== "validated" && this.state !== "moving") throw new ApplyRunStateError(`cannot move while ${this.state}`);
    if (this.inFlight) throw new ApplyRunStateError("another move is in flight");
    if (this.next !== c) throw new ApplyRunStateError("candidates are moved in plan order, one at a time");
    this.state = "moving";
    this.inFlight = c;
    return events.quarantineBegan({ planId: this.plan.id, id: c.id, path: c.path, size: c.size });
  }

  /** `c` arrived in Quarantine intact: its entry becomes quarantined; emits quarantine-done. */
  confirmMoved(c: FsCandidate, at: number): DomainEvent {
    if (this.state !== "moving" || this.inFlight !== c) throw new ApplyRunStateError("this candidate is not being moved");
    this.current = this.current.markQuarantined(this.entryOf(c).index, at);
    this.inFlight = null;
    this.moved.push(c);
    this.nextPosition++;
    return events.quarantineDone({ planId: this.plan.id, id: c.id, path: c.path, size: c.size });
  }

  /** Give up: validated|moving -> aborted; emits apply-aborted. Roll back with `pendingRollback`. */
  abort(reason: AbortReason): DomainEvent {
    if (this.state !== "validated" && this.state !== "moving") throw new ApplyRunStateError(`cannot abort while ${this.state}`);
    this.state = "aborted";
    this.inFlight = null;
    const planId = this.plan.id;
    switch (reason.kind) {
      case "recheck":
        return events.applyAborted({ planId, path: reason.path, reason: reason.why });
      case "rename-failed":
        return events.applyAborted({ planId, path: reason.path, reason: `rename failed (${reason.code})` });
      case "swapped":
        return events.applyAborted({ planId, path: reason.path, reason: "item changed between validation and rename", undone: reason.undone });
    }
  }

  /** Candidates still to put back after an abort, newest first. */
  pendingRollback(): FsCandidate[] {
    if (this.state !== "aborted") throw new ApplyRunStateError("nothing to roll back unless the run was aborted");
    return this.moved.filter((c) => !this.stuck.has(c)).reverse();
  }

  /** `c` was put back at its original path; emits rollback. */
  rolledBack(c: FsCandidate, at: number): DomainEvent {
    this.assertRollbackOf(c);
    this.moved.splice(this.moved.indexOf(c), 1);
    this.current = this.current.rollback(this.entryOf(c).index, at);
    return events.rolledBack({ planId: this.plan.id, path: c.path });
  }

  /** `c` could not be put back; it stays in Quarantine (and in the manifest); emits rollback-failed. */
  rollbackFailed(c: FsCandidate): DomainEvent {
    this.assertRollbackOf(c);
    this.stuck.add(c);
    return events.rollbackFailed({ planId: this.plan.id, path: c.path });
  }

  /** Every Candidate is in Quarantine: moving -> completed (a run with no candidates may complete from validated). */
  complete(): void {
    if (this.state !== "moving" && !(this.state === "validated" && this.candidates.length === 0)) {
      throw new ApplyRunStateError(`cannot complete while ${this.state}`);
    }
    if (this.moved.length !== this.candidates.length) throw new ApplyRunStateError("not every candidate was moved");
    this.state = "completed";
  }

  private assertRollbackOf(c: FsCandidate): void {
    if (this.state !== "aborted") throw new ApplyRunStateError("rollback happens after an abort");
    if (!this.moved.includes(c) || this.stuck.has(c)) throw new ApplyRunStateError("this candidate is not in quarantine");
  }

  private entryOf(c: FsCandidate) {
    const i = this.candidates.indexOf(c);
    const e = i < 0 ? undefined : this.current.entries[i];
    if (!e) throw new QuarantineError("candidate is not part of this run");
    return e;
  }
}
