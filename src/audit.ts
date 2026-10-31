import { constants, lstat, open, readFile } from "node:fs/promises";
import { canonicalJson, sha256Hex } from "./domain/shared/canonical.js";
import { safeJson } from "./domain/shared/escape.js";
import { withLock } from "./lock.js";
import type { State } from "./state.js";

export const GENESIS = "0".repeat(64);
const MAX_AUDIT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;

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

function entryHash(prev: string, e: Pick<AuditEntry, "seq" | "ts" | "event" | "data">): string {
  return sha256Hex(prev + "\n" + canonicalJson({ seq: e.seq, ts: e.ts, event: e.event, data: e.data }));
}

/** Parse and verify a whole audit log text. Exported for tests. */
export function verifyAuditText(text: string): AuditVerification {
  const entries: AuditEntry[] = [];
  let prev = GENESIS;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const fail = (reason: string): AuditVerification => ({ ok: false, count: entries.length, head: prev, line: lineNo, reason, entries });
    const line = lines[i] as string;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return fail("line too long");
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

export class AuditLog {
  constructor(
    private readonly state: State,
    private readonly now: () => number = Date.now,
  ) {}

  async readText(): Promise<string> {
    try {
      const st = await lstat(this.state.auditPath);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error("audit log is not a regular file");
      if (st.size > MAX_AUDIT_BYTES) throw new Error("audit log is too large");
      return await readFile(this.state.auditPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  async verify(): Promise<AuditVerification> {
    return verifyAuditText(await this.readText());
  }

  /** Append one event. Appends are serialized by a lock; the chain is extended from the last verified entry. */
  async append(event: string, data: Record<string, unknown>): Promise<AuditEntry> {
    return withLock(this.state.auditLockPath, 10_000, async () => {
      const text = await this.readText();
      const v = verifyAuditText(text);
      if (!v.ok) throw new Error(`audit log is corrupt at line ${v.line}: ${v.reason}`);
      const base = { seq: v.count + 1, ts: new Date(this.now()).toISOString(), event, data };
      const entry: AuditEntry = { ...base, prev: v.head, hash: entryHash(v.head, base) };
      const line = safeJson(entry) + "\n";
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("audit entry too large");
      const fh = await open(
        this.state.auditPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await fh.writeFile(line);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return entry;
    });
  }
}
