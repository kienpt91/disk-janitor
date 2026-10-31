import type { Signer } from "../../domain/approval/approval.js";
import type { AuditVerification } from "../../domain/audit/chain.js";
import type { EventPublisher } from "./common.js";

/** Persistence of plan documents (text is produced and parsed by the domain). */
export interface PlanStore {
  /** Store plan text under its id (or at `outPath`). Never overwrites. Returns where it was written. */
  write(planId: string, text: string, outPath?: string): Promise<string>;
  /** Read plan text by plan id or file path. */
  read(ref: string, cwd: string): Promise<string>;
}

/** Persistence of approval records (text is produced and verified by the domain). */
export interface ApprovalStore {
  write(planDigest: string, text: string): Promise<void>;
  read(planDigest: string): Promise<string | null>;
  remove(planDigest: string): Promise<void>;
}

/** Access to the per-user signing key. `create` makes the key on first use; otherwise absent means null. */
export interface KeyStore {
  signer(create: boolean): Promise<Signer | null>;
}

/** The audit trail: receives domain events and can be verified (hash chain) and queried. */
export interface AuditTrail extends EventPublisher {
  verify(): Promise<AuditVerification>;
}
