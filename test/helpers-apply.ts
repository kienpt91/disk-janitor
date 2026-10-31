import type { FileStat } from "../src/application/ports/common.js";
import { join } from "node:path";
import { ApplyError, applyPlan, type ApplyResult } from "../src/apply.js";
import { AuditLog, type AuditEntry } from "../src/audit.js";
import { computePlanDigest } from "../src/plan.js";
import { itemPath } from "../src/quarantine.js";
import type { State } from "../src/state.js";
import type { FsCandidate, Plan } from "../src/domain/model/types.js";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeProject, type Planned, type Sandbox } from "./helpers.js";
import type { Deps } from "../src/composition/deps.js";

/** Small deterministic PRNG (mulberry32) for property-style tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fsCandidates(plan: Plan): FsCandidate[] {
  return plan.candidates.filter((c): c is FsCandidate => c.kind === "fs");
}

/**
 * Three projects whose node_modules sizes differ, so the plan lists them as p1, p2, p3
 * (largest first). The last candidate is therefore p3/node_modules.
 */
export function makeThree(sb: Sandbox): { projects: string[]; nms: string[] } {
  const sizes = [40_000, 20_000, 8_192];
  const projects = sizes.map((n, i) => makeProject(join(sb.projects, `p${i + 1}`), { nodeModules: n }));
  return { projects, nms: projects.map((p) => join(p, "node_modules")) };
}

export async function readEvents(state: State): Promise<AuditEntry[]> {
  const v = await new AuditLog(state).verify();
  if (!v.ok) throw new Error(`audit log does not verify: ${v.reason}`);
  return v.entries;
}

export function eventNames(entries: AuditEntry[]): string[] {
  return entries.map((e) => e.event);
}

export function applyInput(p: Planned, deps: Deps = p.deps) {
  return { config: p.config, state: p.state, plan: p.plan, deps };
}

export function runApply(p: Planned, deps: Deps = p.deps): Promise<ApplyResult> {
  return applyPlan(applyInput(p, deps));
}

/** Await a promise that must reject with an ApplyError and return it. */
export async function catchApply(promise: Promise<unknown>): Promise<ApplyError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApplyError) return e;
    throw e;
  }
  throw new Error("expected apply to throw an ApplyError");
}

/** Copy of the plan with edited fs candidates and a recomputed digest (what a malicious plan author would do). */
export function retarget(plan: Plan, edit: (candidates: FsCandidate[]) => void): Plan {
  const copy = structuredClone(plan);
  edit(fsCandidates(copy));
  copy.digest = computePlanDigest(copy);
  return copy;
}

export function storedItem(state: State, plan: Plan, index: number): string {
  return itemPath(state, plan.id, String(index + 1).padStart(4, "0"));
}

/** A FileStat view with a different `dev`; every method keeps working on the real stats. */
export function withDev(st: FileStat, dev: bigint): FileStat {
  return new Proxy(st, {
    get(target, key) {
      if (key === "dev") return dev;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Hash of a tree, leaving out the entries named in `exclude` (absolute paths, present or not). Symlinks are never followed. */
export function hashExcluding(root: string, exclude: ReadonlySet<string>): string {
  const h = createHash("sha256");
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) h.update(`L ${p} -> ${readlinkSync(p)}\n`);
    else if (st.isDirectory()) {
      h.update(`D ${p}\n`);
      for (const n of readdirSync(p).sort()) if (!exclude.has(join(p, n))) walk(join(p, n));
    } else h.update(`F ${p} ${st.size}\n`).update(readFileSync(p));
  };
  walk(root);
  return h.digest("hex");
}

/** Overwrite the path of candidate `index` (plan tampering). */
export function setPath(candidates: FsCandidate[], index: number, path: string): void {
  const c = candidates[index];
  if (!c) throw new Error(`no candidate ${index}`);
  c.path = path;
}
