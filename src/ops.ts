// Operations shared by the CLI and the MCP server. Neither can issue approvals or purge.
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { configCore, type Config, type RawConfig } from "./domain/model/config.js";
import { loadConfigFile } from "./infrastructure/config-file.js";
import { resolveConfig } from "./composition/planning.js";
import type { Deps } from "./composition/deps.js";
import { buildPlan, MAX_PLAN_BYTES, parsePlan, PLAN_ID_RE, writePlanFile } from "./plan.js";
import { scan, type ScanResult } from "./scan.js";
import { openState, type State } from "./state.js";
import type { Plan } from "./domain/model/types.js";

export { configCore, loadConfigFile, resolveConfig };
export type { Config, RawConfig };

export async function openStateFor(config: Pick<Config, "stateDir" | "roots">): Promise<State> {
  return openState(config.stateDir, config.roots);
}

/** Scan only; touches nothing. */
export async function runScan(config: Config, deps: Deps): Promise<ScanResult> {
  return scan(config, deps);
}

export interface CreatedPlan {
  plan: Plan;
  path: string;
}

/** Scan and write a plan file (mode 0600) into the state directory, or to `out`. */
export async function createPlan(config: Config, deps: Deps, out?: string): Promise<CreatedPlan> {
  const state = await openStateFor(config);
  const result = await scan(config, deps);
  const plan = buildPlan(config, result, deps.now());
  const path = out ? resolve(out) : join(state.plansDir, `${plan.id}.json`);
  await writePlanFile(path, plan);
  await new AuditLog(state, deps.now).append("plan-created", {
    planId: plan.id,
    planDigest: plan.digest,
    candidates: plan.candidates.length,
    path,
  });
  return { plan, path };
}

/** Load a plan by id (from the state directory) or by file path. Strict parse and digest check. */
export async function loadPlan(ref: string, state: State, cwd: string): Promise<Plan> {
  const path = PLAN_ID_RE.test(ref) ? join(state.plansDir, `${ref}.json`) : resolve(cwd, ref);
  const st = await lstat(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("plan is not a regular file");
  if (st.size > MAX_PLAN_BYTES) throw new Error("plan file is too large");
  const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return parsePlan(await fh.readFile("utf8"));
  } finally {
    await fh.close();
  }
}

export async function configFromRaw(raw: RawConfig, deps: Deps, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Config> {
  return resolveConfig(raw, deps, opts);
}

