import { join } from "node:path";
import { computePlanDigest } from "../src/plan.js";
import type { Plan } from "../src/types.js";
import { makeMixedTree, planFor, type Planned, type Sandbox } from "./helpers.js";

/** mulberry32 seeded PRNG: returns floats in [0, 1). */
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

export async function mixedPlan(sb: Sandbox): Promise<Planned> {
  makeMixedTree(sb);
  return planFor(sb);
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Apply a mutation and recompute the digest, as a forger who knows the (public) digest rule would. */
export function forge(plan: Plan, mutate: (p: Plan) => void): Plan {
  const p = clone(plan);
  mutate(p);
  p.digest = computePlanDigest(p);
  return p;
}

export function planPath(sb: Sandbox, name = "plan.json"): string {
  return join(sb.state, "plans", name);
}
