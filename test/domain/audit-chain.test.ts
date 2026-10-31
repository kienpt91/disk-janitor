import { describe, expect, it } from "vitest";
import { AuditChain, entryHash, GENESIS, isApprovalConsumed, MAX_AUDIT_LINE_BYTES, type AuditEntry } from "../../src/domain/audit/chain.js";
import { events } from "../../src/domain/events.js";
import { pick, prng, randInt } from "../support/builders.js";

const T0 = Date.UTC(2026, 0, 1);

type Ev = { name: string; data: Record<string, unknown> };

/** Build a chain (and its log text) from events, one millisecond apart. */
function build(list: Ev[]): { chain: AuditChain; text: string; lines: string[] } {
  let chain = AuditChain.empty();
  const lines: string[] = [];
  list.forEach((e, i) => {
    const entry = chain.next(e, T0 + i);
    lines.push(JSON.stringify(entry));
    const parsed = AuditChain.fromText(lines.join("\n") + "\n");
    if (!parsed.ok) throw new Error("fixture chain must verify");
    chain = parsed.chain;
  });
  return { chain, text: lines.length ? lines.join("\n") + "\n" : "", lines };
}

const sample: Ev[] = [
  { name: "plan-created", data: { planId: "p1", n: 1 } },
  { name: "approval-issued", data: { planId: "p1", nonce: "aa" } },
  { name: "approval-consumed", data: { planId: "p1", nonce: "aa" } },
];

function fail(text: string): { line: number; reason: string } {
  const r = AuditChain.fromText(text);
  if (r.ok) throw new Error("expected verification to fail");
  return { line: r.line, reason: r.reason };
}

describe("AuditChain.empty", () => {
  it("starts at genesis with no entries", () => {
    const c = AuditChain.empty();
    expect(c.count).toBe(0);
    expect(c.head).toBe(GENESIS);
    expect(c.head).toBe("0".repeat(64));
    expect(c.entries).toEqual([]);
  });

  it("the empty text verifies as the empty chain", () => {
    const r = AuditChain.fromText("");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chain.count).toBe(0);
      expect(r.chain.head).toBe(GENESIS);
    }
  });
});

describe("AuditChain.next", () => {
  it("first entry has seq 1, genesis prev, ISO timestamp from the given milliseconds", () => {
    const e = AuditChain.empty().next({ name: "plan-created", data: { a: 1 } }, T0 + 123);
    expect(e.seq).toBe(1);
    expect(e.prev).toBe(GENESIS);
    expect(e.ts).toBe("2026-01-01T00:00:00.123Z");
    expect(e.event).toBe("plan-created");
    expect(e.data).toEqual({ a: 1 });
    expect(e.hash).toBe(entryHash(GENESIS, { seq: 1, ts: e.ts, event: "plan-created", data: { a: 1 } }));
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extends from the verified head with the next sequence number", () => {
    const { chain, lines } = build(sample.slice(0, 2));
    const e = chain.next(sample[2] as Ev, T0 + 50);
    expect(e.seq).toBe(3);
    expect(e.prev).toBe(chain.head);
    expect(e.prev).toBe((JSON.parse(lines[1] as string) as AuditEntry).hash);
  });

  it("does not mutate the chain", () => {
    const { chain } = build(sample);
    const before = { count: chain.count, head: chain.head, entries: [...chain.entries] };
    chain.next({ name: "x", data: {} }, T0);
    chain.next({ name: "y", data: {} }, T0);
    expect({ count: chain.count, head: chain.head, entries: [...chain.entries] }).toEqual(before);
  });

  it("is deterministic for the same chain, event and time", () => {
    const { chain } = build(sample);
    expect(chain.next({ name: "x", data: { k: "v" } }, T0 + 9)).toEqual(chain.next({ name: "x", data: { k: "v" } }, T0 + 9));
  });

  it("copies the event data instead of aliasing it", () => {
    const data = { k: "v" };
    const e = AuditChain.empty().next({ name: "x", data }, T0);
    expect(e.data).not.toBe(data);
    expect(e.data).toEqual(data);
  });

  it("different timestamps give different hashes", () => {
    const c = AuditChain.empty();
    expect(c.next({ name: "x", data: {} }, T0).hash).not.toBe(c.next({ name: "x", data: {} }, T0 + 1).hash);
  });

  it("the hash does not depend on data key order", () => {
    const c = AuditChain.empty();
    expect(c.next({ name: "x", data: { a: 1, b: 2 } }, T0).hash).toBe(c.next({ name: "x", data: { b: 2, a: 1 } }, T0).hash);
  });

  it("works with real domain events", () => {
    const ev = events.planCreated({ planId: "p", planDigest: "d", candidates: 1, path: "/x" });
    const e = AuditChain.empty().next(ev, T0);
    expect(e.event).toBe("plan-created");
    expect(e.data).toEqual(ev.data);
  });
});

describe("AuditChain.fromText", () => {
  it("rebuilds count, head and entries from a verified log", () => {
    const { text, lines } = build(sample);
    const r = AuditChain.fromText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain.count).toBe(3);
    expect(r.chain.head).toBe((JSON.parse(lines[2] as string) as AuditEntry).hash);
    expect(r.chain.entries.map((e) => e.event)).toEqual(["plan-created", "approval-issued", "approval-consumed"]);
    expect(r.chain.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("links each entry to the previous hash", () => {
    const r = AuditChain.fromText(build(sample).text);
    if (!r.ok) throw new Error("must verify");
    const es = r.chain.entries;
    expect(es[0]?.prev).toBe(GENESIS);
    expect(es[1]?.prev).toBe(es[0]?.hash);
    expect(es[2]?.prev).toBe(es[1]?.hash);
  });

  it("accepts a log without the trailing newline", () => {
    expect(AuditChain.fromText(build(sample).text.trimEnd()).ok).toBe(true);
  });
});

describe("AuditChain.fromText corruption", () => {
  const good = build(sample).lines;
  const entry = (i: number) => JSON.parse(good[i] as string) as AuditEntry;
  const withLine2 = (line: string) => [good[0], line, good[2]].join("\n") + "\n";

  it("rejects a line that is not JSON", () => {
    expect(fail(withLine2("{not json"))).toEqual({ line: 2, reason: "not valid JSON" });
  });

  it("rejects an empty line in the middle", () => {
    expect(fail(withLine2(""))).toEqual({ line: 2, reason: "not valid JSON" });
  });

  it.each([["array", "[1,2]"], ["null", "null"], ["number", "7"], ["string", '"x"']])("rejects a %s line as not an object", (_n, line) => {
    expect(fail(withLine2(line))).toEqual({ line: 2, reason: "not an object" });
  });

  it("rejects an extra field", () => {
    expect(fail(withLine2(JSON.stringify({ ...entry(1), extra: 1 })))).toEqual({ line: 2, reason: "unexpected fields" });
  });

  it.each(["seq", "ts", "event", "data", "prev", "hash"] as const)("rejects a missing %s field", (key) => {
    const e: Record<string, unknown> = { ...entry(1) };
    delete e[key];
    expect(fail(withLine2(JSON.stringify(e)))).toEqual({ line: 2, reason: "unexpected fields" });
  });

  it.each([
    ["seq", "2"],
    ["ts", 5],
    ["event", 5],
    ["hash", 5],
    ["prev", 5],
  ] as const)("rejects a %s of the wrong type", (key, value) => {
    expect(fail(withLine2(JSON.stringify({ ...entry(1), [key]: value })))).toEqual({ line: 2, reason: "bad field types" });
  });

  it.each([["null", null], ["array", []], ["string", "x"]])("rejects data that is %s", (_n, data) => {
    expect(fail(withLine2(JSON.stringify({ ...entry(1), data })))).toEqual({ line: 2, reason: "bad data" });
  });

  it("rejects a sequence number out of order even with a valid hash", () => {
    const base = { seq: 5, ts: "2026-01-01T00:00:00.001Z", event: "x", data: {} };
    const e = { ...base, prev: entry(0).hash, hash: entryHash(entry(0).hash, base) };
    expect(fail(withLine2(JSON.stringify(e)))).toEqual({ line: 2, reason: "sequence number out of order" });
  });

  it("rejects a repeated sequence number (duplicated line)", () => {
    expect(fail([good[0], good[0]].join("\n") + "\n")).toEqual({ line: 2, reason: "sequence number out of order" });
  });

  it("rejects a broken previous-hash link even with a self-consistent hash", () => {
    const wrongPrev = "f".repeat(64);
    const base = { seq: 2, ts: "2026-01-01T00:00:00.001Z", event: "x", data: {} };
    const e = { ...base, prev: wrongPrev, hash: entryHash(wrongPrev, base) };
    expect(fail(withLine2(JSON.stringify(e)))).toEqual({ line: 2, reason: "chain broken: previous hash does not match" });
  });

  it("rejects modified data as a hash mismatch", () => {
    const e = { ...entry(1), data: { planId: "p1", nonce: "bb" } };
    expect(fail(withLine2(JSON.stringify(e)))).toEqual({ line: 2, reason: "hash mismatch: entry was modified" });
  });

  it("rejects a modified timestamp or event name as a hash mismatch", () => {
    expect(fail(withLine2(JSON.stringify({ ...entry(1), ts: "2027-01-01T00:00:00.000Z" }))).reason).toBe("hash mismatch: entry was modified");
    expect(fail(withLine2(JSON.stringify({ ...entry(1), event: "approval-declined" }))).reason).toBe("hash mismatch: entry was modified");
  });

  it("rejects a log with a middle entry removed", () => {
    expect(fail([good[0], good[2]].join("\n") + "\n")).toEqual({ line: 2, reason: "sequence number out of order" });
  });

  it("rejects reordered entries", () => {
    expect(fail([good[1], good[0], good[2]].join("\n") + "\n").line).toBe(1);
  });

  it("rejects a line larger than the limit", () => {
    const big = JSON.stringify({ ...entry(1), data: { blob: "x".repeat(MAX_AUDIT_LINE_BYTES) } });
    expect(fail(withLine2(big))).toEqual({ line: 2, reason: "line too long" });
  });

  it("measures the limit in bytes, not characters", () => {
    const wide = "é".repeat(MAX_AUDIT_LINE_BYTES / 2 + 1);
    expect(fail(withLine2(JSON.stringify({ ...entry(1), data: { wide } }))).reason).toBe("line too long");
  });

  it("reports the failing line number for a corruption on the last line", () => {
    expect(fail([good[0], good[1], "garbage"].join("\n") + "\n")).toEqual({ line: 3, reason: "not valid JSON" });
  });
});

describe("isApprovalConsumed / hasConsumedApproval", () => {
  const { chain } = build([
    { name: "approval-issued", data: { nonce: "n1" } },
    { name: "approval-consumed", data: { nonce: "n2" } },
    { name: "apply-start", data: { nonce: "n3" } },
  ]);

  it("is true only for a consumed event with that nonce", () => {
    expect(isApprovalConsumed(chain.entries, "n2")).toBe(true);
    expect(chain.hasConsumedApproval("n2")).toBe(true);
  });

  it("an issued approval is not a consumed one", () => {
    expect(isApprovalConsumed(chain.entries, "n1")).toBe(false);
  });

  it("other events carrying the nonce do not count", () => {
    expect(chain.hasConsumedApproval("n3")).toBe(false);
  });

  it("unknown nonces and the empty chain are not consumed", () => {
    expect(chain.hasConsumedApproval("nope")).toBe(false);
    expect(AuditChain.empty().hasConsumedApproval("n2")).toBe(false);
    expect(isApprovalConsumed([], "n2")).toBe(false);
  });
});

describe("audit chain properties (seeded)", () => {
  const names = ["plan-created", "approval-issued", "approval-consumed", "apply-start", "quarantine-done", "rollback"];
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 _-./";

  function randomEvents(r: () => number): Ev[] {
    const n = randInt(r, 1, 12);
    return Array.from({ length: n }, () => {
      const data: Record<string, unknown> = {};
      for (let k = 0; k < randInt(r, 0, 4); k++) {
        const key = "k" + randInt(r, 0, 9);
        const kind = randInt(r, 0, 3);
        data[key] =
          kind === 0
            ? randInt(r, 0, 1_000_000)
            : kind === 1
              ? Array.from({ length: randInt(r, 0, 4) }, () => pick(r, alphabet.split("")) as string).join("")
              : kind === 2
                ? r() < 0.5
                : { nested: randInt(r, 0, 99) };
      }
      return { name: pick(r, names), data };
    });
  }

  it("random chains of random events verify and report their own head", () => {
    const r = prng(20260101);
    for (let i = 0; i < 40; i++) {
      const evs = randomEvents(r);
      const { chain, text } = build(evs);
      const parsed = AuditChain.fromText(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.chain.count).toBe(evs.length);
      expect(parsed.chain.head).toBe(chain.head);
      expect(parsed.chain.entries.map((e) => ({ name: e.event, data: e.data }))).toEqual(evs.map((e) => ({ name: e.name, data: e.data })));
    }
  });

  it("any single-character mutation of any line breaks verification at that line", () => {
    const r = prng(77);
    for (let i = 0; i < 12; i++) {
      const { lines } = build(randomEvents(r));
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li] as string;
        for (let attempt = 0; attempt < 25; attempt++) {
          const pos = randInt(r, 0, line.length - 1);
          const original = line[pos] as string;
          let replacement = original;
          while (replacement === original) replacement = pick(r, "abcdefghijklmnopqrstuvwxyz0123456789{}[]\":,. ".split(""));
          const mutated = lines.map((l, k) => (k === li ? line.slice(0, pos) + replacement + line.slice(pos + 1) : l));
          const result = AuditChain.fromText(mutated.join("\n") + "\n");
          expect(result.ok, `line ${li + 1} pos ${pos}: ${original} -> ${replacement}`).toBe(false);
          if (!result.ok) expect(result.line).toBe(li + 1);
        }
      }
    }
  });

  it("deleting any single line of a chain of three or more breaks verification", () => {
    const r = prng(5);
    for (let i = 0; i < 10; i++) {
      const { lines } = build([...randomEvents(r), ...sample]);
      for (let li = 0; li < lines.length; li++) {
        const rest = lines.filter((_, k) => k !== li);
        if (rest.length === 0) continue;
        const res = AuditChain.fromText(rest.join("\n") + "\n");
        // removing the last line leaves a valid shorter chain; anything else must fail
        expect(res.ok).toBe(li === lines.length - 1);
      }
    }
  });
});
