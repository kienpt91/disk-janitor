import { constants, lstat, open, readFile } from "node:fs/promises";
import type { AuditTrail } from "../../application/ports/planning.js";
import { AuditChain, verifyAuditText, type AuditEntry, type AuditVerification } from "../../domain/audit/chain.js";
import type { DomainEvent } from "../../domain/events.js";
import { safeJson } from "../../domain/shared/escape.js";
import { withLock } from "../fs/file-lock.js";
import type { State } from "./state-dir.js";

const MAX_AUDIT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;

/** Append-only JSONL audit log on disk (mode 0600, O_NOFOLLOW), extending the domain's hash chain. */
export class AuditLog implements AuditTrail {
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

  /** Publish a domain event: it becomes the next entry of the chain. */
  async publish(event: DomainEvent): Promise<void> {
    await this.append(event.name, event.data);
  }

  /** Append one event. Appends are serialized by a lock; the chain is extended from the last verified entry. */
  async append(event: string, data: Record<string, unknown>): Promise<AuditEntry> {
    return withLock(this.state.auditLockPath, 10_000, async () => {
      const parsed = AuditChain.fromText(await this.readText());
      if (!parsed.ok) throw new Error(`audit log is corrupt at line ${parsed.line}: ${parsed.reason}`);
      const entry = parsed.chain.next({ name: event, data }, this.now());
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
