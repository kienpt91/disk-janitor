// Composition root for configuration, planning and approvals: wires adapters to the application
// use cases and keeps the Deps-based convenience API used by the CLI, the MCP server, the tests and
// library users.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveConfig as resolveConfigUseCase } from "../application/config.js";
import {
  consumeApproval as consumeApprovalUseCase,
  issueApproval as issueApprovalUseCase,
  verifyApproval as verifyApprovalUseCase,
  type VerifiedApproval,
} from "../application/approvals.js";
import { createPlan as createPlanUseCase, loadPlan as loadPlanUseCase, type CreatedPlan } from "../application/plans.js";
import type { Config, RawConfig } from "../domain/model/config.js";
import type { Plan } from "../domain/model/types.js";
import type { ApprovalRecord } from "../domain/approval/approval.js";
import { buildPlan as buildPlanDomain, serializePlan, type PlanInput } from "../domain/plan/plan.js";
import { cryptoIds } from "../infrastructure/random-ids.js";
import { FileApprovalStore } from "../infrastructure/state/approval-store.js";
import { AuditLog } from "../infrastructure/state/audit-log.js";
import { FileKeyStore } from "../infrastructure/state/key-store.js";
import { FilePlanStore, writePlanText } from "../infrastructure/state/plan-store.js";
import { openState, type State } from "../infrastructure/state/state-dir.js";
import type { Deps } from "./deps.js";
import { scan } from "./discovery.js";

export interface ResolveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve user input into a validated Config using the real process environment unless overridden. */
export async function resolveConfig(raw: RawConfig, deps: Deps, opts: ResolveOptions = {}): Promise<Config> {
  return resolveConfigUseCase(raw, deps, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    homeDir: homedir(),
  });
}

export async function openStateFor(config: Pick<Config, "stateDir" | "roots">): Promise<State> {
  return openState(config.stateDir, config.roots);
}

/** The adapters the planning and approval use cases need, built over one state directory. */
export function planningPorts(state: State, deps: Pick<Deps, "now">) {
  const audit = new AuditLog(state, deps.now);
  return {
    clock: { now: deps.now },
    ids: cryptoIds,
    plans: new FilePlanStore(state),
    approvals: new FileApprovalStore(state),
    keys: new FileKeyStore(state),
    audit,
    events: audit,
  };
}

/** Build a plan document in memory (random id). Use createPlan to persist one. */
export function buildPlan(config: Config, result: PlanInput, nowMs: number): Plan {
  return buildPlanDomain(config, result, nowMs, cryptoIds.hex(4));
}

export async function writePlanFile(path: string, plan: Plan): Promise<void> {
  await writePlanText(path, serializePlan(plan));
}

export type { CreatedPlan };

/** Scan, build the plan through the aggregate, write it (mode 0600) to the state directory or `out`. */
export async function createPlan(config: Config, deps: Deps, out?: string): Promise<CreatedPlan> {
  const state = await openStateFor(config);
  const found = await scan(config, deps);
  return createPlanUseCase(planningPorts(state, deps), config, found, out ? resolve(out) : undefined);
}

/** Load a plan by id (from the state directory) or by file path. Strict parse and digest check. */
export async function loadPlan(ref: string, state: State, cwd: string): Promise<Plan> {
  return loadPlanUseCase({ plans: new FilePlanStore(state) }, ref, cwd);
}

/** Stand-in for the human step: write an approval record (the CLI calls the approve use case instead). */
export async function issueApproval(state: State, plan: Plan, nowMs: number, validityMs?: number): Promise<ApprovalRecord> {
  return issueApprovalUseCase(planningPorts(state, { now: () => nowMs }), plan, validityMs);
}

export async function verifyApproval(state: State, plan: Plan, nowMs: number, audit: AuditLog): Promise<VerifiedApproval> {
  const ports = planningPorts(state, { now: () => nowMs });
  return verifyApprovalUseCase({ ...ports, audit }, plan);
}

export async function consumeApproval(state: State, record: ApprovalRecord, audit: AuditLog): Promise<void> {
  const ports = planningPorts(state, { now: () => Date.now() });
  await consumeApprovalUseCase({ approvals: ports.approvals, events: audit }, record);
}
