import { describe, expect, it } from "vitest";
import { EVENT_NAMES, events, type DomainEvent } from "../../src/domain/events.js";

type Ctor = (d: never) => DomainEvent;

const cases: Array<[keyof typeof events, string, Record<string, unknown>]> = [
  ["planCreated", "plan-created", { planId: "p1", planDigest: "d1", candidates: 3, path: "/state/plans/p1.json" }],
  ["approvalIssued", "approval-issued", { planId: "p1", planDigest: "d1", expiresAt: 1_900_000_000_000, nonce: "ab".repeat(16), approver: "terminal" }],
  ["approvalDeclined", "approval-declined", { planId: "p1", planDigest: "d1", approver: "os-dialog" }],
  ["approvalConsumed", "approval-consumed", { planId: "p1", planDigest: "d1", nonce: "cd".repeat(16) }],
  ["applyRefused", "apply-refused", { planId: "p1", planDigest: "d1", reason: "plan changed" }],
  ["applyStarted", "apply-start", { planId: "p1", planDigest: "d1", fs: 4 }],
  ["applyAborted", "apply-aborted", { planId: "p1", reason: "validation failed", path: "/a/b", problems: ["x", "y"], undone: true }],
  ["quarantineBegan", "quarantine-begin", { planId: "p1", id: "c0001", path: "/a/node_modules", size: 10 }],
  ["quarantineDone", "quarantine-done", { planId: "p1", id: "c0001", path: "/a/node_modules", size: 10 }],
  ["rolledBack", "rollback", { planId: "p1", path: "/a/node_modules" }],
  ["rollbackFailed", "rollback-failed", { planId: "p1", path: "/a/node_modules" }],
  ["applyCompleted", "apply-complete", { planId: "p1", moved: 2, docker: 1 }],
  ["dockerPruneBegan", "docker-prune-begin", { planId: "p1", resource: "build-cache" }],
  ["dockerPruneDone", "docker-prune-done", { planId: "p1", resource: "build-cache", ok: false, detail: "daemon unavailable" }],
  ["restoreBegan", "restore-begin", { planId: "p1", path: "/a/node_modules" }],
  ["restoreDone", "restore-done", { planId: "p1", path: "/a/node_modules" }],
  ["restoreRefused", "restore-refused", { planId: "p1", path: "/a/node_modules", reason: "target exists" }],
  ["restoreFailed", "restore-failed", { planId: "p1", path: "/a/node_modules", reason: "io error" }],
  ["purgeBegan", "purge-begin", { planId: "p1", stored: "s1", path: "/a/node_modules", size: 10 }],
  ["purgeDone", "purge-done", { planId: "p1", stored: "s1", path: "/a/node_modules" }],
  ["purgeFailed", "purge-failed", { planId: "p1", stored: "s1", reason: "busy" }],
];

describe("domain events", () => {
  it("the table covers every constructor exactly once", () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(Object.keys(events).sort());
  });

  it.each(cases)("%s produces %s with the exact payload", (key, name, data) => {
    const make = events[key] as unknown as Ctor;
    const e = make(data as never);
    expect(e.name).toBe(name);
    expect(e.data).toEqual(data);
    expect(Object.keys(e).sort()).toEqual(["data", "name"]);
  });

  it("EVENT_NAMES has no duplicates", () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  it("every constructor's name is in EVENT_NAMES and every name has one constructor", () => {
    expect(cases.map((c) => c[1]).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it("names are lowercase kebab-case", () => {
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it.each(cases)("%s event is plain JSON that survives a round trip", (key, _name, data) => {
    const e = (events[key] as unknown as Ctor)(data as never);
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  it("omitted optional fields stay absent from the payload", () => {
    const e = events.applyAborted({ planId: "p1", reason: "stopped" });
    expect(e.data).toEqual({ planId: "p1", reason: "stopped" });
    expect("path" in e.data).toBe(false);
  });

  it("constructors do not share or alias their input", () => {
    const input = { planId: "p1", planDigest: "d1", approver: "terminal" };
    const e = events.approvalDeclined(input);
    expect(e.data).toEqual(input);
  });
});
