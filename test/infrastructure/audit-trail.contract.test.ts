import { readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuditTrail } from "../../src/application/ports/planning.js";
import { GENESIS } from "../../src/domain/audit/chain.js";
import { events, type DomainEvent } from "../../src/domain/events.js";
import { AuditLog } from "../../src/infrastructure/state/audit-log.js";
import { FakeClock } from "../support/fakes/clock.js";
import { MemoryAuditTrail } from "../support/fakes/memory-stores.js";
import { openSandboxState } from "../support/state.js";

interface Harness {
  /** A trail instance over the shared storage; each call gives another instance over the same log. */
  open(now: () => number): AuditTrail;
  readText(): string;
  writeText(text: string): void;
}

async function memory(): Promise<Harness> {
  const storage = { text: "" };
  return {
    open: (now) => new MemoryAuditTrail(now, storage),
    readText: () => storage.text,
    writeText: (t) => void (storage.text = t),
  };
}

async function file(): Promise<Harness> {
  const { state } = await openSandboxState();
  return {
    open: (now) => new AuditLog(state, now),
    readText: () => readFileSync(state.auditPath, "utf8"),
    writeText: (t) => writeFileSync(state.auditPath, t),
  };
}

const sampleEvents = (n: number): DomainEvent[] =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 0
      ? events.planCreated({ planId: `p${i}`, planDigest: "d".repeat(64), candidates: i, path: `/plans/p${i}.json` })
      : i % 3 === 1
        ? events.approvalIssued({ planId: `p${i}`, planDigest: "d".repeat(64), expiresAt: 1_000 + i, nonce: String(i).padStart(32, "0"), approver: "terminal" })
        : events.approvalConsumed({ planId: `p${i}`, planDigest: "d".repeat(64), nonce: String(i).padStart(32, "0") }),
  );

describe.each([
  ["memory", memory],
  ["file", file],
])("AuditTrail contract: %s", (_name, make) => {
  it("an empty trail verifies with no entries", async () => {
    const h = await make();
    const v = await h.open(() => 0).verify();
    expect(v).toMatchObject({ ok: true, count: 0, head: GENESIS, entries: [] });
  });

  it("publishing N events yields a verified chain of N linked entries", async () => {
    const h = await make();
    const clock = new FakeClock();
    const trail = h.open(() => clock.now());
    const list = sampleEvents(7);
    for (const e of list) {
      await trail.publish(e);
      clock.advance(1000);
    }
    const v = await trail.verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(7);
    expect(v.entries).toHaveLength(7);
    v.entries.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(e.prev).toBe(i === 0 ? GENESIS : v.entries[i - 1]?.hash);
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(v.head).toBe(v.entries[6]?.hash);
  });

  it("events appear in publication order with their name and data", async () => {
    const h = await make();
    const trail = h.open(() => 0);
    const list = sampleEvents(5);
    for (const e of list) await trail.publish(e);
    const v = await trail.verify();
    expect(v.entries.map((e) => ({ name: e.event, data: e.data }))).toEqual(list.map((e) => ({ name: e.name, data: e.data })));
  });

  it("timestamps come from the clock handed to the adapter", async () => {
    const h = await make();
    const clock = new FakeClock(Date.UTC(2026, 5, 15, 8, 30, 0));
    const trail = h.open(() => clock.now());
    await trail.publish(sampleEvents(1)[0] as DomainEvent);
    clock.advance(90_500);
    await trail.publish(sampleEvents(2)[1] as DomainEvent);
    expect((await trail.verify()).entries.map((e) => e.ts)).toEqual(["2026-06-15T08:30:00.000Z", "2026-06-15T08:31:30.500Z"]);
  });

  it("a second adapter instance over the same storage continues the chain", async () => {
    const h = await make();
    const a = h.open(() => 1);
    const b = h.open(() => 2);
    await a.publish(sampleEvents(1)[0] as DomainEvent);
    await b.publish(sampleEvents(2)[1] as DomainEvent);
    await a.publish(sampleEvents(3)[2] as DomainEvent);
    const v = await h.open(() => 3).verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(3);
    expect(v.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(v.entries[1]?.prev).toBe(v.entries[0]?.hash);
    expect(v.entries[2]?.prev).toBe(v.entries[1]?.hash);
  });

  it("concurrent publishes all land and keep the chain valid", async () => {
    const h = await make();
    const trail = h.open(() => 5);
    await Promise.all(sampleEvents(6).map((e) => trail.publish(e)));
    const v = await trail.verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(6);
    expect(new Set(v.entries.map((e) => e.seq)).size).toBe(6);
  });

  it("verification reports tampering with an existing entry", async () => {
    const h = await make();
    const trail = h.open(() => 0);
    for (const e of sampleEvents(3)) await trail.publish(e);
    h.writeText(h.readText().replace('"candidates":0', '"candidates":9'));
    const v = await trail.verify();
    expect(v).toMatchObject({ ok: false, line: 1, reason: "hash mismatch: entry was modified", count: 0 });
  });

  it("refuses to append to a corrupt log", async () => {
    const h = await make();
    const trail = h.open(() => 0);
    for (const e of sampleEvents(2)) await trail.publish(e);
    h.writeText(h.readText() + "garbage\n");
    await expect(trail.publish(sampleEvents(1)[0] as DomainEvent)).rejects.toThrow("audit log is corrupt at line 3: not valid JSON");
  });

  it("verification reports a deleted entry", async () => {
    const h = await make();
    const trail = h.open(() => 0);
    for (const e of sampleEvents(3)) await trail.publish(e);
    const lines = h.readText().split("\n");
    h.writeText([lines[0], lines[2]].join("\n") + "\n");
    expect(await trail.verify()).toMatchObject({ ok: false, line: 2, reason: "sequence number out of order" });
  });
});

describe("AuditLog on disk", () => {
  it("creates the log file with mode 0600, one JSON object per line", async () => {
    const { state } = await openSandboxState();
    const log = new AuditLog(state, () => 0);
    for (const e of sampleEvents(3)) await log.publish(e);
    expect(statSync(state.auditPath).mode & 0o777).toBe(0o600);
    const lines = readFileSync(state.auditPath, "utf8").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    for (const l of lines.slice(0, 3)) expect(JSON.parse(l)).toHaveProperty("hash");
  });

  it("the chain continues across adapter instances created at different times", async () => {
    const { state } = await openSandboxState();
    await new AuditLog(state, () => 1).publish(sampleEvents(1)[0] as DomainEvent);
    const second = new AuditLog(state, () => 2);
    await second.publish(sampleEvents(2)[1] as DomainEvent);
    const v = await new AuditLog(state, () => 3).verify();
    expect(v).toMatchObject({ ok: true, count: 2 });
  });

  it("releases the append lock after publishing", async () => {
    const { state } = await openSandboxState();
    await new AuditLog(state, () => 0).publish(sampleEvents(1)[0] as DomainEvent);
    expect(() => statSync(state.auditLockPath)).toThrow(/ENOENT/);
  });
});
