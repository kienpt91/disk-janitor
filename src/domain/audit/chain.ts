import { canonicalJson, sha256Hex } from "../shared/canonical.js";

export const GENESIS = "0".repeat(64);
export const MAX_AUDIT_LINE_BYTES = 256 * 1024;

export interface AuditEntry {
  seq: number;
  ts: string;
  event: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

export type AuditVerification =
  | { ok: true; count: number; head: string; entries: AuditEntry[] }
  | { ok: false; count: number; head: string; line: number; reason: string; entries: AuditEntry[] };

export function entryHash(prev: string, e: Pick<AuditEntry, "seq" | "ts" | "event" | "data">): string {
  return sha256Hex(prev + "\n" + canonicalJson({ seq: e.seq, ts: e.ts, event: e.event, data: e.data }));
}

/** Parse and verify a whole audit log text line by line. */
export function verifyAuditText(text: string): AuditVerification {
  const entries: AuditEntry[] = [];
  let prev = GENESIS;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const fail = (reason: string): AuditVerification => ({ ok: false, count: entries.length, head: prev, line: lineNo, reason, entries });
    const line = lines[i] as string;
    if (new TextEncoder().encode(line).length > MAX_AUDIT_LINE_BYTES) return fail("line too long");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return fail("not valid JSON");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(",");
    if (keys !== "data,event,hash,prev,seq,ts") return fail("unexpected fields");
    if (typeof o["seq"] !== "number" || typeof o["ts"] !== "string" || typeof o["event"] !== "string") return fail("bad field types");
    if (typeof o["hash"] !== "string" || typeof o["prev"] !== "string") return fail("bad field types");
    if (o["data"] === null || typeof o["data"] !== "object" || Array.isArray(o["data"])) return fail("bad data");
    const entry = o as unknown as AuditEntry;
    if (entry.seq !== i + 1) return fail("sequence number out of order");
    if (entry.prev !== prev) return fail("chain broken: previous hash does not match");
    if (entryHash(prev, entry) !== entry.hash) return fail("hash mismatch: entry was modified");
    entries.push(entry);
    prev = entry.hash;
  }
  return { ok: true, count: entries.length, head: prev, entries };
}

/** Has an approval with this nonce already been consumed according to the log? */
export function isApprovalConsumed(entries: readonly AuditEntry[], nonce: string): boolean {
  return entries.some((e) => e.event === "approval-consumed" && e.data["nonce"] === nonce);
}

/**
 * The audit log as an aggregate: an append-only hash chain. It can only be rebuilt from a text that
 * verifies, and its only mutation is `next`, which extends the chain from the verified head.
 */
export class AuditChain {
  private constructor(
    readonly count: number,
    readonly head: string,
    readonly entries: readonly AuditEntry[],
  ) {}

  static empty(): AuditChain {
    return new AuditChain(0, GENESIS, []);
  }

  /** Rebuild from log text. Returns the verification failure instead of a chain when the text is corrupt. */
  static fromText(text: string): { ok: true; chain: AuditChain } | { ok: false; line: number; reason: string } {
    const v = verifyAuditText(text);
    if (!v.ok) return { ok: false, line: v.line, reason: v.reason };
    return { ok: true, chain: new AuditChain(v.count, v.head, v.entries) };
  }

  /** The entry that extends this chain with `event` at time `tsMs`. Does not mutate the chain. */
  next(event: { name: string; data: Readonly<Record<string, unknown>> }, tsMs: number): AuditEntry {
    const base = { seq: this.count + 1, ts: new Date(tsMs).toISOString(), event: event.name, data: { ...event.data } };
    return { ...base, prev: this.head, hash: entryHash(this.head, base) };
  }

  hasConsumedApproval(nonce: string): boolean {
    return isApprovalConsumed(this.entries, nonce);
  }
}
