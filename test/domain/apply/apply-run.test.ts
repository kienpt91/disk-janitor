import { describe, expect, it } from "vitest";
import { ApplyRun, ApplyRunStateError } from "../../../src/domain/apply/apply-run.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import type { FsCandidate } from "../../../src/domain/model/types.js";
import { Manifest } from "../../../src/domain/quarantine/manifest.js";
import { candidate, newManifest, PLAN_ID } from "../../support/domain-fixtures.js";

const plan = { id: PLAN_ID };
const names = (es: DomainEvent[]) => es.map((e) => e.name);

function start(count = 3): { run: ApplyRun; cs: FsCandidate[] } {
  const cs = Array.from({ length: count }, (_, i) => candidate(i + 1));
  return { run: ApplyRun.begin(plan, newManifest(count), cs), cs };
}

/** Moves the first `n` candidates; returns the events in order. */
function moveFirst(run: ApplyRun, cs: FsCandidate[], n: number, at = 100): DomainEvent[] {
  const out: DomainEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(run.beginMove(cs[i] as FsCandidate));
    out.push(run.confirmMoved(cs[i] as FsCandidate, at + i));
  }
  return out;
}

describe("ApplyRun construction", () => {
  it("starts validated with nothing moved and the first candidate next", () => {
    const { run, cs } = start();
    expect(run.phase).toBe("validated");
    expect(run.movedCandidates).toEqual([]);
    expect(run.next).toBe(cs[0]);
    expect(run.storedNameOf(cs[1] as FsCandidate)).toBe("0002");
  });

  it("refuses a manifest of another plan, with the wrong number of entries, or not pending / not matching", () => {
    const cs = [candidate(1), candidate(2)];
    expect(() => ApplyRun.begin({ id: "plan-20260101T000000Z-bbbbbbbb" }, newManifest(2), cs)).toThrow("different plan");
    expect(() => ApplyRun.begin(plan, newManifest(1), cs)).toThrow("one entry per candidate");
    expect(() => ApplyRun.begin(plan, newManifest(2).markQuarantined(1, 1), cs)).toThrow(ApplyRunStateError);
    expect(() => ApplyRun.begin(plan, newManifest(2), [candidate(2), candidate(1)])).toThrow(ApplyRunStateError);
  });

  it("a candidate that is not part of the run is unknown", () => {
    const { run } = start(1);
    expect(() => run.storedNameOf(candidate(9))).toThrow("not part of this run");
  });
});

describe("ApplyRun events and transitions (happy path)", () => {
  it("emits quarantine-begin and quarantine-done per candidate in order and marks the manifest", () => {
    const { run, cs } = start(2);
    const events = moveFirst(run, cs, 2);
    expect(names(events)).toEqual(["quarantine-begin", "quarantine-done", "quarantine-begin", "quarantine-done"]);
    expect(events[0]?.data).toEqual({ planId: PLAN_ID, id: "c0001", path: cs[0]?.path, size: cs[0]?.size });
    expect(events[3]?.data).toEqual({ planId: PLAN_ID, id: "c0002", path: cs[1]?.path, size: cs[1]?.size });
    expect(run.phase).toBe("moving");
    expect(run.manifest.entries.map((e) => [e.status, e.quarantinedAt])).toEqual([["quarantined", 100], ["quarantined", 101]]);
    expect(run.next).toBeUndefined();
    run.complete();
    expect(run.phase).toBe("completed");
  });

  it("a run with no candidates completes straight from validated", () => {
    const run = ApplyRun.begin(plan, newManifest(0), []);
    run.complete();
    expect(run.phase).toBe("completed");
  });
});

describe("ApplyRun illegal use", () => {
  it("candidates are moved in plan order, one at a time", () => {
    const { run, cs } = start();
    expect(() => run.beginMove(cs[1] as FsCandidate)).toThrow("plan order");
    run.beginMove(cs[0] as FsCandidate);
    expect(() => run.beginMove(cs[0] as FsCandidate)).toThrow("another move is in flight");
  });

  it("confirmMoved needs a move in flight for that very candidate", () => {
    const { run, cs } = start();
    expect(() => run.confirmMoved(cs[0] as FsCandidate, 1)).toThrow("not being moved");
    run.beginMove(cs[0] as FsCandidate);
    expect(() => run.confirmMoved(cs[1] as FsCandidate, 1)).toThrow("not being moved");
  });

  it("complete needs every candidate moved", () => {
    const { run, cs } = start();
    expect(() => run.complete()).toThrow("cannot complete while validated");
    moveFirst(run, cs, 1);
    expect(() => run.complete()).toThrow("not every candidate was moved");
  });

  it("nothing can be moved, aborted or completed after completion", () => {
    const { run, cs } = start(1);
    moveFirst(run, cs, 1);
    run.complete();
    expect(() => run.beginMove(cs[0] as FsCandidate)).toThrow("cannot move while completed");
    expect(() => run.abort({ kind: "recheck", path: "/x", why: "y" })).toThrow("cannot abort while completed");
    expect(() => run.complete()).toThrow("cannot complete while completed");
  });

  it("after an abort nothing more is moved and it cannot be aborted twice", () => {
    const { run, cs } = start();
    run.abort({ kind: "recheck", path: "/x", why: "y" });
    expect(run.phase).toBe("aborted");
    expect(() => run.beginMove(cs[0] as FsCandidate)).toThrow("cannot move while aborted");
    expect(() => run.abort({ kind: "recheck", path: "/x", why: "y" })).toThrow("cannot abort while aborted");
    expect(() => run.complete()).toThrow("cannot complete while aborted");
  });

  it("rollback is only possible after an abort", () => {
    const { run, cs } = start();
    moveFirst(run, cs, 1);
    expect(() => run.pendingRollback()).toThrow("unless the run was aborted");
    expect(() => run.rolledBack(cs[0] as FsCandidate, 1)).toThrow("after an abort");
    expect(() => run.rollbackFailed(cs[0] as FsCandidate)).toThrow("after an abort");
  });

  it("only a candidate in quarantine can be rolled back, and only once", () => {
    const { run, cs } = start();
    moveFirst(run, cs, 1);
    run.abort({ kind: "recheck", path: "/x", why: "y" });
    expect(() => run.rolledBack(cs[1] as FsCandidate, 1)).toThrow("not in quarantine");
    run.rolledBack(cs[0] as FsCandidate, 5);
    expect(() => run.rolledBack(cs[0] as FsCandidate, 6)).toThrow("not in quarantine");
  });
});

describe("ApplyRun aborts and rollback bookkeeping", () => {
  it("recheck failure: apply-aborted{planId,path,reason}", () => {
    const { run } = start();
    const e = run.abort({ kind: "recheck", path: "/p", why: "path disappeared" });
    expect(e).toEqual({ name: "apply-aborted", data: { planId: PLAN_ID, path: "/p", reason: "path disappeared" } });
  });

  it("rename failure: reason names the error code", () => {
    const { run, cs } = start();
    run.beginMove(cs[0] as FsCandidate);
    const e = run.abort({ kind: "rename-failed", path: "/p", code: "EXDEV" });
    expect(e).toEqual({ name: "apply-aborted", data: { planId: PLAN_ID, path: "/p", reason: "rename failed (EXDEV)" } });
    expect(run.pendingRollback()).toEqual([]);
  });

  it("swap: reason and whether the item was put back", () => {
    const { run, cs } = start();
    run.beginMove(cs[0] as FsCandidate);
    expect(run.abort({ kind: "swapped", path: "/p", undone: true })).toEqual({
      name: "apply-aborted",
      data: { planId: PLAN_ID, path: "/p", reason: "item changed between validation and rename", undone: true },
    });
  });

  it("rolls back moved candidates newest first, recording rollback / rollback-failed in the manifest", () => {
    const { run, cs } = start(4);
    moveFirst(run, cs, 3);
    run.beginMove(cs[3] as FsCandidate);
    const abort = run.abort({ kind: "rename-failed", path: cs[3]?.path as string, code: "EIO" });
    const order = run.pendingRollback();
    expect(order.map((c) => c.id)).toEqual(["c0003", "c0002", "c0001"]);
    const events = [abort];
    events.push(run.rolledBack(order[0] as FsCandidate, 200));
    events.push(run.rollbackFailed(order[1] as FsCandidate));
    events.push(run.rolledBack(order[2] as FsCandidate, 201));
    expect(names(events)).toEqual(["apply-aborted", "rollback", "rollback-failed", "rollback"]);
    expect(events[1]?.data).toEqual({ planId: PLAN_ID, path: cs[2]?.path });
    expect(run.manifest.entries.map((e) => [e.status, e.restoredAt])).toEqual([["restored", 201], ["quarantined", undefined], ["restored", 200], ["pending", undefined]]);
    expect(run.movedCandidates.map((c) => c.id)).toEqual(["c0002"]);
  });

  it("the manifest of an aborted run stays a valid, sealable manifest", () => {
    const { run, cs } = start(2);
    moveFirst(run, cs, 1);
    run.abort({ kind: "recheck", path: "/x", why: "y" });
    run.rolledBack(cs[0] as FsCandidate, 9);
    expect(Manifest.fromBody(run.manifest.toBody()).entries[0]?.status).toBe("restored");
  });

  it("a candidate that fails mid-move is not in quarantine and is not rolled back", () => {
    const { run, cs } = start(2);
    moveFirst(run, cs, 1);
    run.beginMove(cs[1] as FsCandidate);
    run.abort({ kind: "swapped", path: "/x", undone: false });
    expect(run.pendingRollback().map((c) => c.id)).toEqual(["c0001"]);
    expect(run.manifest.entry(2)?.status).toBe("pending");
  });
});

describe("ApplyRun property: event order", () => {
  it("for any failure position the events are begin/done pairs, one abort, then one rollback event per moved candidate (newest first)", () => {
    for (let n = 1; n <= 5; n++) {
      for (let failAt = 0; failAt < n; failAt++) {
        const { run, cs } = start(n);
        const events = moveFirst(run, cs, failAt);
        events.push(run.beginMove(cs[failAt] as FsCandidate));
        events.push(run.abort({ kind: "rename-failed", path: cs[failAt]?.path as string, code: "EIO" }));
        for (const c of run.pendingRollback()) events.push(run.rolledBack(c, 500));
        const expected = [...Array(failAt).fill(["quarantine-begin", "quarantine-done"]).flat(), "quarantine-begin", "apply-aborted", ...Array(failAt).fill("rollback")];
        expect(names(events)).toEqual(expected);
        expect(events.filter((e) => e.name === "rollback").map((e) => e.data["path"])).toEqual(cs.slice(0, failAt).map((c) => c.path).reverse());
        expect(run.manifest.entries.every((e) => e.status === "restored" || e.status === "pending")).toBe(true);
      }
    }
  });
});
