// In-memory implementations of the planning/approval ports, for application tests and for the
// adapter contract suites (which run the same assertions against these and the real adapters).
import { resolve } from "node:path";
import type { HumanIO } from "../../../src/application/human-confirmation.js";
import type { ApplyLock, EventPublisher, Lease } from "../../../src/application/ports/common.js";
import type { ApprovalStore, AuditTrail, KeyStore, PlanStore } from "../../../src/application/ports/planning.js";
import type { Signer } from "../../../src/domain/approval/approval.js";
import { AuditChain, verifyAuditText, type AuditVerification } from "../../../src/domain/audit/chain.js";
import { LockHeldError } from "../../../src/domain/errors.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import { MAX_PLAN_BYTES, PLAN_ID_RE } from "../../../src/domain/plan/plan.js";
import { sha256Hex } from "../../../src/domain/shared/canonical.js";
import { safeJson } from "../../../src/domain/shared/escape.js";

function errno(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

export const MEMORY_PLANS_DIR = "/memory-state/plans";

export class MemoryPlanStore implements PlanStore {
  private readonly files = new Map<string, string>();
  private readonly symlinks = new Set<string>();

  async write(planId: string, text: string, outPath?: string): Promise<string> {
    const path = outPath ? resolve(outPath) : `${MEMORY_PLANS_DIR}/${planId}.json`;
    if (this.files.has(path) || this.symlinks.has(path)) throw errno("EEXIST", `file already exists, open '${path}'`);
    this.files.set(path, text);
    return path;
  }

  async read(ref: string, cwd: string): Promise<string> {
    const path = PLAN_ID_RE.test(ref) ? `${MEMORY_PLANS_DIR}/${ref}.json` : resolve(cwd, ref);
    if (this.symlinks.has(path)) throw new Error("plan is not a regular file");
    const text = this.files.get(path);
    if (text === undefined) throw errno("ENOENT", `no such file or directory, lstat '${path}'`);
    if (Buffer.byteLength(text, "utf8") > MAX_PLAN_BYTES) throw new Error("plan file is too large");
    return text;
  }

  /** Test setup: put raw text at a path, bypassing the no-overwrite rule. */
  seed(path: string, text: string): void {
    this.files.set(path, text);
  }

  seedSymlink(path: string): void {
    this.symlinks.add(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  get size(): number {
    return this.files.size;
  }
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly files = new Map<string, string>();

  private check(planDigest: string): void {
    if (!/^[0-9a-f]{64}$/.test(planDigest)) throw new Error("invalid plan digest");
  }

  async write(planDigest: string, text: string): Promise<void> {
    this.check(planDigest);
    this.files.set(planDigest, text);
  }

  async read(planDigest: string): Promise<string | null> {
    this.check(planDigest);
    return this.files.get(planDigest) ?? null;
  }

  async remove(planDigest: string): Promise<void> {
    this.check(planDigest);
    if (!this.files.delete(planDigest)) throw errno("ENOENT", `no such file or directory, unlink '${planDigest}.json'`);
  }

  /** File names as the real adapter would show them. */
  names(): string[] {
    return [...this.files.keys()].map((d) => `${d}.json`).sort();
  }

  get size(): number {
    return this.files.size;
  }
}

/** Where a MemoryKeyStore keeps its key; share one vault between instances to model one key file. */
export interface KeyVault {
  key: string | null;
}

/** Deterministic hash-based signer: the same key signs the same message identically. */
export function hashSigner(key: string): Signer {
  return { sign: (message) => sha256Hex(`${key}\n${message}`) };
}

export class MemoryKeyStore implements KeyStore {
  constructor(
    readonly vault: KeyVault = { key: null },
    private readonly generate: () => string = () => "generated-test-key",
  ) {}

  async signer(create: boolean): Promise<Signer | null> {
    if (this.vault.key === null && create) this.vault.key = this.generate();
    return this.vault.key === null ? null : hashSigner(this.vault.key);
  }
}

/** Where a MemoryAuditTrail keeps its log text; share between instances to model one log file. */
export interface AuditStorage {
  text: string;
}

/** The audit trail built on the domain hash chain, held in memory. */
export class MemoryAuditTrail implements AuditTrail, EventPublisher {
  constructor(
    private readonly now: () => number,
    readonly storage: AuditStorage = { text: "" },
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const parsed = AuditChain.fromText(this.storage.text);
    if (!parsed.ok) throw new Error(`audit log is corrupt at line ${parsed.line}: ${parsed.reason}`);
    this.storage.text += safeJson(parsed.chain.next(event, this.now())) + "\n";
  }

  async verify(): Promise<AuditVerification> {
    return verifyAuditText(this.storage.text);
  }

  /** The logged events as name/data pairs, in order. */
  async logged(): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
    return (await this.verify()).entries.map((e) => ({ name: e.event, data: e.data }));
  }
}

export class RecordingEvents implements EventPublisher {
  readonly events: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }

  names(): string[] {
    return this.events.map((e) => e.name);
  }
}

export interface TerminalOptions {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  env?: Record<string, string | undefined>;
}

/** A terminal whose answers are queued in advance and whose output is recorded. */
export class ScriptedTerminal implements HumanIO {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Record<string, string | undefined>;
  readonly written: string[] = [];
  readonly prompts: string[] = [];

  constructor(
    private readonly answers: string[] = [],
    opts: TerminalOptions = {},
  ) {
    this.stdinIsTTY = opts.stdinIsTTY ?? true;
    this.stdoutIsTTY = opts.stdoutIsTTY ?? true;
    this.env = opts.env ?? {};
  }

  write(text: string): void {
    this.written.push(text);
  }

  async ask(question: string): Promise<string> {
    this.prompts.push(question);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("ScriptedTerminal: no answer queued for prompt");
    return answer;
  }
}

/** Where a MemoryApplyLock keeps its holder; share between instances to model one lock file. */
export interface LockState {
  holder: symbol | null;
}

export class MemoryApplyLock implements ApplyLock {
  constructor(private readonly state: LockState = { holder: null }) {}

  async acquire(): Promise<Lease> {
    if (this.state.holder !== null) throw new LockHeldError("another disk-janitor operation holds the lock (memory)");
    const me = Symbol("lease");
    this.state.holder = me;
    return {
      release: async () => {
        if (this.state.holder === me) this.state.holder = null;
      },
    };
  }
}
