import { readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/domain/shared/canonical.js";
import { AuditLog } from "../../src/infrastructure/state/audit-log.js";
import { GENESIS, verifyAuditText } from "../../src/domain/audit/chain.js";
import { openState } from "../../src/infrastructure/state/state-dir.js";
import { makeSandbox } from "../support/helpers.js";

async function setup(n = 0) {
  const sb = makeSandbox();
  const state = await openState(sb.state, [sb.projects]);
  let t = Date.UTC(2026, 0, 1);
  const audit = new AuditLog(state, () => (t += 1000));
  for (let i = 1; i <= n; i++) await audit.append(`event-${i}`, { i, name: `item ${i}` });
  return { sb, state, audit };
}

const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
const write = (p: string, ls: string[]) => writeFileSync(p, ls.join("\n") + "\n");

function failure(text: string) {
  const v = verifyAuditText(text);
  expect(v.ok).toBe(false);
  if (v.ok) throw new Error("unreachable");
  return v;
}

describe("append / verify", () => {
  it("an empty log verifies with the genesis head", async () => {
    const { audit } = await setup();
    const v = await audit.verify();
    expect(v).toEqual({ ok: true, count: 0, head: GENESIS, entries: [] });
  });

  it("builds a hash chain with seq, prev and hash", async () => {
    const { audit } = await setup(3);
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(3);
    expect(v.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(v.entries[0]?.prev).toBe(GENESIS);
    expect(v.entries[1]?.prev).toBe(v.entries[0]?.hash);
    expect(v.entries[2]?.prev).toBe(v.entries[1]?.hash);
    expect(v.head).toBe(v.entries[2]?.hash);
    const e = v.entries[1]!;
    expect(e.hash).toBe(sha256Hex(e.prev + "\n" + canonicalJson({ seq: e.seq, ts: e.ts, event: e.event, data: e.data })));
    expect(e.ts).toBe(new Date(Date.UTC(2026, 0, 1) + 2000).toISOString());
  });

  it("append returns the stored entry", async () => {
    const { audit } = await setup(1);
    const e = await audit.append("x", { a: 1 });
    expect(e.seq).toBe(2);
    expect(e.event).toBe("x");
    expect((await audit.verify()).ok && (await audit.verify()).head).toBe(e.hash);
  });

  it("stores one JSON object per line with mode 0600", async () => {
    const { state } = await setup(4);
    expect(statSync(state.auditPath).mode & 0o777).toBe(0o600);
    const ls = lines(state.auditPath);
    expect(ls).toHaveLength(4);
    for (const l of ls) expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(["data", "event", "hash", "prev", "seq", "ts"]);
  });

  it("a second AuditLog instance continues the same chain", async () => {
    const { state, audit } = await setup(2);
    const other = new AuditLog(state, () => 5);
    await other.append("more", {});
    expect((await audit.verify()).count).toBe(3);
  });

  it("20 concurrent appends yield seq 1..20 and a valid chain without lost entries", async () => {
    const { audit } = await setup();
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit.append("concurrent", { i })));
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    expect(v.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(v.entries.map((e) => (e.data as { i: number }).i).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("concurrent appends from separate AuditLog instances also keep the chain intact", async () => {
    const { state } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => new AuditLog(state, () => i).append("c", { i })));
    const v = await new AuditLog(state).verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(10);
  });
});

describe("tamper detection", () => {
  it("modified data field -> hash mismatch on that line", async () => {
    const { state } = await setup(4);
    const ls = lines(state.auditPath);
    const o = JSON.parse(ls[1] as string) as { data: { i: number } };
    o.data.i = 99;
    ls[1] = JSON.stringify(o);
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(2);
    expect(v.reason).toMatch(/hash mismatch/);
    expect(v.count).toBe(1);
  });

  it("changed event name", async () => {
    const { state } = await setup(3);
    const ls = lines(state.auditPath);
    ls[2] = ls[2]!.replace("event-3", "event-X");
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(3);
  });

  it("deleted middle line", async () => {
    const { state } = await setup(4);
    const ls = lines(state.auditPath);
    ls.splice(1, 1);
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(2);
    expect(v.reason).toMatch(/sequence/);
  });

  it("swapped two lines", async () => {
    const { state } = await setup(4);
    const ls = lines(state.auditPath);
    [ls[1], ls[2]] = [ls[2] as string, ls[1] as string];
    write(state.auditPath, ls);
    expect(failure(readFileSync(state.auditPath, "utf8")).line).toBe(2);
  });

  it("dropped first line", async () => {
    const { state } = await setup(3);
    write(state.auditPath, lines(state.auditPath).slice(1));
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(1);
  });

  it("forged appended line with a wrong prev", async () => {
    const { state } = await setup(2);
    const ls = lines(state.auditPath);
    const base = { seq: 3, ts: "2026-01-01T00:00:00.000Z", event: "forged", data: {} };
    const prev = "f".repeat(64);
    const hash = sha256Hex(prev + "\n" + canonicalJson(base));
    ls.push(JSON.stringify({ ...base, prev, hash }));
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(3);
    expect(v.reason).toMatch(/chain broken/);
  });

  it("forged appended line with correct prev but wrong hash", async () => {
    const { state, audit } = await setup(2);
    const head = (await audit.verify()).head;
    const ls = lines(state.auditPath);
    ls.push(JSON.stringify({ seq: 3, ts: "t", event: "forged", data: {}, prev: head, hash: "0".repeat(64) }));
    write(state.auditPath, ls);
    expect(failure(readFileSync(state.auditPath, "utf8")).reason).toMatch(/hash mismatch/);
  });

  it("a forger who knows the hash rule can only extend, and the head changes", async () => {
    const { state, audit } = await setup(2);
    const before = (await audit.verify()).head;
    const base = { seq: 3, ts: "t", event: "forged", data: {} };
    const ls = lines(state.auditPath);
    ls.push(JSON.stringify({ ...base, prev: before, hash: sha256Hex(before + "\n" + canonicalJson(base)) }));
    write(state.auditPath, ls);
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    expect(v.head).not.toBe(before);
  });

  it("edited hash", async () => {
    const { state } = await setup(3);
    const ls = lines(state.auditPath);
    const o = JSON.parse(ls[0] as string) as { hash: string };
    o.hash = (o.hash[0] === "a" ? "b" : "a") + o.hash.slice(1);
    ls[0] = JSON.stringify(o);
    write(state.auditPath, ls);
    expect(failure(readFileSync(state.auditPath, "utf8")).line).toBe(1);
  });

  it("invalid JSON line", async () => {
    const { state } = await setup(3);
    const ls = lines(state.auditPath);
    ls[1] = "{broken";
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(2);
    expect(v.reason).toBe("not valid JSON");
  });

  it("extra keys", async () => {
    const { state } = await setup(2);
    const ls = lines(state.auditPath);
    const o = JSON.parse(ls[1] as string) as Record<string, unknown>;
    o["extra"] = true;
    ls[1] = JSON.stringify(o);
    write(state.auditPath, ls);
    const v = failure(readFileSync(state.auditPath, "utf8"));
    expect(v.line).toBe(2);
    expect(v.reason).toBe("unexpected fields");
  });

  it("non-object lines and bad field types", () => {
    expect(failure("[]\n").reason).toBe("not an object");
    expect(failure("null\n").reason).toBe("not an object");
    expect(failure('{"seq":"1","ts":"t","event":"e","data":{},"prev":"p","hash":"h"}\n').reason).toBe("bad field types");
    expect(failure('{"seq":1,"ts":"t","event":"e","data":[],"prev":"p","hash":"h"}\n').reason).toBe("bad data");
  });

  it("a blank line in the middle is rejected", async () => {
    const { state } = await setup(2);
    const ls = lines(state.auditPath);
    writeFileSync(state.auditPath, ls[0] + "\n\n" + ls[1] + "\n");
    expect(failure(readFileSync(state.auditPath, "utf8")).line).toBe(2);
  });

  it("tail truncation is not detected by the chain, but the head hash changes (external anchor would notice)", async () => {
    const { state, audit } = await setup(5);
    const full = await audit.verify();
    write(state.auditPath, lines(state.auditPath).slice(0, 3));
    const cut = await audit.verify();
    expect(cut.ok).toBe(true);
    expect(cut.count).toBe(3);
    expect(cut.head).not.toBe(full.head);
    expect(cut.head).toBe(full.entries[2]?.hash);
  });

  it("append to a corrupt log throws and leaves the file unchanged", async () => {
    const { state, audit } = await setup(3);
    const ls = lines(state.auditPath);
    ls[1] = ls[1]!.replace("event-2", "event-Z");
    write(state.auditPath, ls);
    const before = readFileSync(state.auditPath, "utf8");
    await expect(audit.append("x", {})).rejects.toThrow(/audit log is corrupt at line 2/);
    expect(readFileSync(state.auditPath, "utf8")).toBe(before);
  });
});

describe("file handling and hostile data", () => {
  it("refuses an audit log that is a symlink (read and append)", async () => {
    const { sb, state, audit } = await setup();
    const target = `${sb.base}/elsewhere.jsonl`;
    writeFileSync(target, "");
    symlinkSync(target, state.auditPath);
    await expect(audit.verify()).rejects.toThrow(/not a regular file/);
    await expect(audit.append("x", {})).rejects.toThrow(/not a regular file/);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("refuses an audit log that is a directory", async () => {
    const { state, audit } = await setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(state.auditPath);
    await expect(audit.verify()).rejects.toThrow(/not a regular file/);
  });

  it("stores newline, bidi and ESC data escaped on a single line and still verifies", async () => {
    const { state, audit } = await setup();
    const nasty = "a\nb\r\n\u001b[31mred\u001b[0m \u202Eevil\u2066 \u200b\u0085 end";
    await audit.append("hostile", { path: nasty, [`k\n${"\u202e"}`]: 1 });
    const raw = readFileSync(state.auditPath, "utf8");
    expect(raw.split("\n")).toHaveLength(2);
    expect(raw).not.toMatch(/[\u001b\u202e\u2066\u200b\u0085\r]/);
    expect(raw).toContain("\\u001b");
    expect(raw).toContain("\\u202e");
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    expect((v.entries[0]?.data as { path: string }).path).toBe(nasty);
  });

  it("rejects an entry above 256 KiB on append and leaves the log intact", async () => {
    const { audit } = await setup(1);
    await expect(audit.append("big", { blob: "x".repeat(300 * 1024) })).rejects.toThrow(/too large/);
    const v = await audit.verify();
    expect(v.ok && v.count).toBe(1);
  });

  it("rejects a line above 256 KiB on verify", () => {
    const v = failure("x".repeat(256 * 1024 + 1) + "\n");
    expect(v.reason).toBe("line too long");
    expect(v.line).toBe(1);
  });

  it("a missing log file is an empty log, and removing the log restarts the chain at genesis", async () => {
    const { state, audit } = await setup(2);
    unlinkSync(state.auditPath);
    const e = await audit.append("restart", {});
    expect(e.seq).toBe(1);
    expect(e.prev).toBe(GENESIS);
  });
});
