// Manifest: the record of what one applied Plan moved into Quarantine, and the lifecycle of every
// entry (pending -> quarantined -> restored | purged). It is sealed with a keyed MAC so that a
// manifest that was edited outside this tool is never trusted: restore and purge act only on
// authenticated manifests.
//
//   pending ──markQuarantined──▶ quarantined ──markPurged──▶ purged
//      │                              │
//      └────────markRestored──────────┴──markRestored / rollback──▶ restored
//
// Manifest values are immutable: every transition returns a new Manifest.

import { constantTimeEqual, type Signer } from "../approval/approval.js";
import { DAY_MS, DETECTOR_IDS, type FsCandidate } from "../model/types.js";
import { PLAN_ID_RE } from "../plan/plan.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { isCanonicalAbsolute } from "../shared/paths.js";
import { arr, int, literal, obj, opt, parseJson, SchemaError, str, type Infer, type Parser } from "../shared/schema.js";
import { IllegalTransitionError, QuarantineError } from "./errors.js";

export const DEFAULT_PURGE_TTL_DAYS = 7;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const STORED_NAME_RE = /^[0-9]{4,6}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAC_DOMAIN = "disk-janitor/manifest/v1\n";
const PURGE_DOMAIN = "disk-janitor/purge/v1\n";

const canonicalPath: Parser<string> = (v, p) => {
  const s = str({ min: 1, max: 4096 })(v, p);
  if (!isCanonicalAbsolute(s)) throw new SchemaError(`${p}: not a canonical absolute path`);
  return s;
};

const entryParser = obj({
  index: int({ min: 1, max: 100_000 }),
  stored: str({ pattern: STORED_NAME_RE, max: 6 }),
  originalPath: canonicalPath,
  detector: literal(...DETECTOR_IDS),
  dev: str({ pattern: /^[0-9]{1,20}$/ }),
  ino: str({ pattern: /^[0-9]{1,20}$/ }),
  size: int(),
  mtimeMs: int(),
  status: literal("pending", "quarantined", "restored", "purged"),
  quarantinedAt: opt(int()),
  restoredAt: opt(int()),
  purgedAt: opt(int()),
});

const bodyShape = {
  version: literal(1),
  planId: str({ pattern: PLAN_ID_RE }),
  planDigest: str({ pattern: HEX64 }),
  createdAt: int(),
  roots: arr(canonicalPath, { max: 64 }),
  home: canonicalPath,
  detectors: arr(literal(...DETECTOR_IDS), { max: 16 }),
  entries: arr(entryParser, { max: 5000 }),
};
const bodyParser = obj(bodyShape);
const recordParser = obj({ ...bodyShape, mac: str({ pattern: HEX64 }) });

export type ManifestEntry = Infer<typeof entryParser>;
export type EntryStatus = ManifestEntry["status"];
/** A Manifest without its seal. */
export type ManifestBody = Infer<typeof bodyParser>;
/** What is stored: the body plus its MAC. */
export type ManifestRecord = Infer<typeof recordParser>;

/** What restore and purge need to know about the configuration the Plan was applied under. */
export interface ManifestScope {
  roots: string[];
  home: string;
  detectors: ManifestBody["detectors"];
}

/** An entry that is eligible for permanent deletion. */
export interface PurgeItem {
  planId: string;
  entry: ManifestEntry;
  ageDays: number;
}

export function assertPlanId(planId: string): void {
  if (!PLAN_ID_RE.test(planId)) throw new QuarantineError("invalid plan id");
}

export function assertStoredName(stored: string): void {
  if (!STORED_NAME_RE.test(stored)) throw new QuarantineError("invalid stored item name");
}

export function storedName(index: number): string {
  return String(index).padStart(4, "0");
}

const isTimestamp = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

function macInput(body: ManifestBody): string {
  return MAC_DOMAIN + canonicalJson(body);
}

export interface NewManifest {
  planId: string;
  planDigest: string;
  createdAt: number;
  roots: readonly string[];
  home: string;
  detectors: ManifestBody["detectors"];
  /** The file-system Candidates of the Plan, in the order they will be moved. */
  candidates: ReadonlyArray<Pick<FsCandidate, "path" | "detector" | "dev" | "ino" | "size" | "mtimeMs">>;
}

export class Manifest {
  private constructor(private readonly body: ManifestBody) {}

  /** A fresh manifest with every entry pending. */
  static create(input: NewManifest): Manifest {
    return Manifest.fromBody({
      version: 1,
      planId: input.planId,
      planDigest: input.planDigest,
      createdAt: input.createdAt,
      roots: [...input.roots],
      home: input.home,
      detectors: [...input.detectors],
      entries: input.candidates.map((c, i) => ({
        index: i + 1,
        stored: storedName(i + 1),
        originalPath: c.path,
        detector: c.detector,
        dev: c.dev,
        ino: c.ino,
        size: c.size,
        mtimeMs: c.mtimeMs,
        status: "pending" as const,
      })),
    });
  }

  /** Validate a body (schema and invariants) and wrap it. */
  static fromBody(body: ManifestBody): Manifest {
    let parsed: ManifestBody;
    try {
      parsed = bodyParser(body, "");
    } catch (e) {
      if (e instanceof SchemaError) throw new QuarantineError(`manifest: ${e.message}`);
      throw e;
    }
    return Manifest.checked(parsed);
  }

  private static checked(body: ManifestBody): Manifest {
    const stored = new Set<string>();
    const indexes = new Set<number>();
    for (const e of body.entries) {
      if (stored.has(e.stored)) throw new QuarantineError("manifest has duplicate stored names");
      if (indexes.has(e.index)) throw new QuarantineError("manifest has duplicate entry indexes");
      stored.add(e.stored);
      indexes.add(e.index);
    }
    return new Manifest(body);
  }

  /**
   * Authenticate stored text: strict parse, belongs to `expectedPlanId`, MAC valid under `signer`
   * (null when no key exists). Throws QuarantineError on anything but a manifest this tool sealed.
   */
  static open(text: string, expectedPlanId: string, signer: Signer | null): Manifest {
    let record: ManifestRecord;
    try {
      record = parseJson(text, recordParser, MAX_MANIFEST_BYTES, "manifest");
    } catch (e) {
      throw new QuarantineError(e instanceof SchemaError ? e.message : "manifest unreadable");
    }
    if (record.planId !== expectedPlanId) throw new QuarantineError("manifest belongs to a different plan");
    if (!signer) throw new QuarantineError("approval key missing: cannot authenticate manifest");
    const { mac, ...body } = record;
    if (!constantTimeEqual(mac, signer.sign(macInput(body)))) {
      throw new QuarantineError("manifest signature is invalid: it was modified");
    }
    return Manifest.checked(body);
  }

  /** The body with its keyed MAC, ready to store. */
  seal(signer: Signer): ManifestRecord {
    return { ...this.toBody(), mac: signer.sign(macInput(this.body)) };
  }

  /** A deep copy of the body (callers may edit it freely). */
  toBody(): ManifestBody {
    return structuredClone(this.body);
  }

  get planId(): string {
    return this.body.planId;
  }

  get planDigest(): string {
    return this.body.planDigest;
  }

  get createdAt(): number {
    return this.body.createdAt;
  }

  get scope(): ManifestScope {
    return { roots: [...this.body.roots], home: this.body.home, detectors: [...this.body.detectors] };
  }

  get entries(): readonly ManifestEntry[] {
    return this.body.entries;
  }

  entry(index: number): ManifestEntry | undefined {
    return this.body.entries.find((e) => e.index === index);
  }

  entryByStored(stored: string): ManifestEntry | undefined {
    return this.body.entries.find((e) => e.stored === stored);
  }

  /** Entries that restore may act on: moved (or about to be moved) and not yet restored or purged. */
  restorable(): ManifestEntry[] {
    return this.body.entries.filter(isRestorableEntry);
  }

  /** Restorable entries whose original path is exactly `path`. */
  restorableAt(path: string): ManifestEntry[] {
    return this.restorable().filter((e) => e.originalPath === path);
  }

  /** Quarantined entries that have been there for at least `ttlMs` at `nowMs`. */
  purgeEligible(nowMs: number, ttlMs: number): PurgeItem[] {
    const out: PurgeItem[] = [];
    for (const entry of this.body.entries) {
      const age = purgeAgeMs(entry, nowMs);
      if (age !== null && age >= ttlMs) out.push({ planId: this.planId, entry, ageDays: Math.floor(age / DAY_MS) });
    }
    return out;
  }

  /** The Apply moved this entry into Quarantine. pending -> quarantined. */
  markQuarantined(index: number, at: number): Manifest {
    return this.transition(index, at, ["pending"], "quarantined", (e) => ({ ...e, status: "quarantined", quarantinedAt: at }));
  }

  /** The item was put back at its original path. pending|quarantined -> restored. */
  markRestored(index: number, at: number): Manifest {
    return this.transition(index, at, ["pending", "quarantined"], "restored", (e) => ({ ...e, status: "restored", restoredAt: at }));
  }

  /** An aborted Apply put a moved item back. quarantined -> restored. */
  rollback(index: number, at: number): Manifest {
    return this.transition(index, at, ["quarantined"], "restored", (e) => ({ ...e, status: "restored", restoredAt: at }));
  }

  /** The item was permanently deleted. quarantined -> purged. */
  markPurged(index: number, at: number): Manifest {
    return this.transition(index, at, ["quarantined"], "purged", (e) => ({ ...e, status: "purged", purgedAt: at }));
  }

  private transition(index: number, at: number, from: EntryStatus[], to: EntryStatus, change: (e: ManifestEntry) => ManifestEntry): Manifest {
    if (!isTimestamp(at)) throw new QuarantineError("timestamp must be a non-negative integer");
    const entry = this.entry(index);
    if (!entry) throw new QuarantineError(`manifest has no entry ${index}`);
    if (!from.includes(entry.status)) throw new IllegalTransitionError(entry.stored, entry.status, to);
    return new Manifest({ ...this.body, entries: this.body.entries.map((e) => (e.index === index ? change(e) : e)) });
  }
}

export function isRestorableEntry(e: Pick<ManifestEntry, "status">): boolean {
  return e.status === "quarantined" || e.status === "pending";
}

/** Milliseconds an entry has been in Quarantine at `nowMs`; null when it is not quarantined. */
export function purgeAgeMs(entry: ManifestEntry, nowMs: number): number | null {
  if (entry.status !== "quarantined" || entry.quarantinedAt === undefined) return null;
  return nowMs - entry.quarantinedAt;
}

/** Stable identifier of a purge set; the human types its prefix to confirm. Order independent. */
export function purgeSetDigest(items: ReadonlyArray<{ planId: string; entry: Pick<ManifestEntry, "stored"> }>): string {
  const ids = items.map((i) => `${i.planId}:${i.entry.stored}`).sort();
  return sha256Hex(PURGE_DOMAIN + ids.join("\n"));
}
