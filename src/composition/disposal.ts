// Composition root for disposal: applying a Plan into Quarantine, restoring, listing and purging.
// It wires the adapters to the use cases and keeps the (State, Deps)-based convenience API used by
// the CLI, the MCP server, the tests and library users.

import { applyPlan as applyPlanUseCase, type ApplyPorts, type ApplyResult } from "../application/apply-plan.js";
import { purgeCandidates as purgeCandidatesUseCase, purgeItems as purgeItemsUseCase, type PurgeResult } from "../application/purge.js";
import { listQuarantine as listQuarantineUseCase, readManifest as readManifestUseCase } from "../application/quarantine-listing.js";
import {
  findRestoreTargets as findRestoreTargetsUseCase,
  previewRestore as previewRestoreUseCase,
  restore as restoreUseCase,
  type RestoreCheck,
} from "../application/restore.js";
import type { Config } from "../domain/model/config.js";
import type { Plan } from "../domain/model/types.js";
import { Manifest, type ManifestBody, type ManifestEntry, type PurgeItem } from "../domain/quarantine/manifest.js";
import type { EventPublisher, FileSystem } from "../application/ports/common.js";
import { nodeFs } from "../infrastructure/fs/node-fs.js";
import { FileKeyStore } from "../infrastructure/state/key-store.js";
import { FileApplyLock } from "../infrastructure/fs/file-lock.js";
import { createDocker } from "../infrastructure/process/docker.js";
import { createLsof } from "../infrastructure/process/lsof.js";
import { FileQuarantineStore } from "../infrastructure/state/quarantine-store.js";
import type { State } from "../infrastructure/state/state-dir.js";
import type { Deps } from "./deps.js";
import { planningPorts } from "./planning.js";

export { ApplyError, type ApplyFailure, type ApplyResult } from "../application/apply-plan.js";
export type { PurgeResult } from "../application/purge.js";
export type { RestoreCheck } from "../application/restore.js";
export { QuarantineError } from "../domain/quarantine/errors.js";
export { DEFAULT_PURGE_TTL_DAYS, purgeSetDigest, type ManifestBody, type ManifestEntry, type PurgeItem } from "../domain/quarantine/manifest.js";

export interface ApplyInput {
  config: Config;
  state: State;
  plan: Plan;
  deps: Deps;
}

export interface QuarantineListing {
  manifests: ManifestBody[];
  problems: Array<{ planId: string; reason: string }>;
}

function quarantineStore(state: State): FileQuarantineStore {
  return new FileQuarantineStore(state.quarantineDir, new FileKeyStore(state));
}

/** Adapters for the disposal use cases over one state directory. */
export function disposalPorts(state: State, deps: Deps): ApplyPorts & { events: EventPublisher } {
  const planning = planningPorts(state, deps);
  return {
    clock: planning.clock,
    fs: deps.fs,
    lock: new FileApplyLock(state.lockPath),
    keys: planning.keys,
    approvals: planning.approvals,
    audit: planning.audit,
    events: planning.audit,
    quarantine: new FileQuarantineStore(state.quarantineDir, planning.keys),
    openFiles: createLsof(deps.run),
    docker: createDocker(deps.run),
    hooks: deps.hooks,
  };
}

/**
 * Apply an approved plan: verify the approval, re-validate everything, then move candidates into
 * quarantine with rename (never copy+delete, never unlink). Docker candidates run last.
 */
export function applyPlan(input: ApplyInput): Promise<ApplyResult> {
  return applyPlanUseCase(disposalPorts(input.state, input.deps), input.config, input.plan);
}

export function planQuarantineDir(state: State, planId: string): string {
  return quarantineStore(state).planDir(planId);
}

export function itemsDir(state: State, planId: string): string {
  return quarantineStore(state).itemsDir(planId);
}

export function manifestPath(state: State, planId: string): string {
  return quarantineStore(state).manifestPath(planId);
}

export function itemPath(state: State, planId: string, stored: string): string {
  return quarantineStore(state).itemPath(planId, stored);
}

/** Seal and store a manifest body (validated first). */
export async function writeManifest(state: State, manifest: ManifestBody): Promise<void> {
  await quarantineStore(state).save(Manifest.fromBody(manifest));
}

/** Read and authenticate a manifest. Returns null when the plan has no manifest. Throws QuarantineError on tampering. */
export async function readManifest(state: State, planId: string): Promise<ManifestBody | null> {
  const m = await readManifestUseCase({ quarantine: quarantineStore(state) }, planId);
  return m ? m.toBody() : null;
}

function listPorts(state: State, fs: FileSystem = nodeFs) {
  return { quarantine: quarantineStore(state), fs };
}

export async function listQuarantine(state: State): Promise<QuarantineListing> {
  const l = await listQuarantineUseCase(listPorts(state));
  return { manifests: l.manifests.map((m) => m.toBody()), problems: l.problems };
}

/** What restore would do, without doing it. */
export function previewRestore(state: State, deps: Deps, selector: string): Promise<RestoreCheck[]> {
  return previewRestoreUseCase(listPorts(state, deps.fs), selector);
}

/** Faithful undo: rename each quarantined item back to its original path; never overwrite. */
export function restore(state: State, deps: Deps, events: EventPublisher, selector: string): Promise<RestoreCheck[]> {
  return restoreUseCase({ ...listPorts(state, deps.fs), clock: { now: deps.now }, events }, selector);
}

/** Items eligible for permanent deletion: listed in an authenticated manifest, quarantined at least `ttlMs` ago. */
export async function purgeCandidates(state: State, ttlMs: number, nowMs: number): Promise<{ items: PurgeItem[]; problems: QuarantineListing["problems"] }> {
  return purgeCandidatesUseCase(listPorts(state), ttlMs, nowMs);
}

/** Permanently delete the given items. Only paths derived from manifest entries inside the quarantine are touched. */
export function purgeItems(state: State, deps: Deps, events: EventPublisher, items: PurgeItem[]): Promise<PurgeResult> {
  return purgeItemsUseCase({ ...listPorts(state, deps.fs), clock: { now: deps.now }, events }, items);
}
