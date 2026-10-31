import type { Config } from "../domain/model/config.js";
import type { Plan } from "../domain/model/types.js";
import { PlanAggregate, type PlanInput } from "../domain/plan/plan.js";
import { events } from "../domain/events.js";
import type { Clock, EventPublisher, IdSource } from "./ports/common.js";
import type { PlanStore } from "./ports/planning.js";

export interface CreatePlanPorts {
  clock: Clock;
  ids: IdSource;
  plans: PlanStore;
  events: EventPublisher;
}

export interface CreatedPlan {
  plan: Plan;
  path: string;
}

/**
 * CreatePlan use case: turn what discovery found into a Plan (the aggregate enforces its
 * invariants), persist it, and publish `plan-created`. Nothing on disk is touched except the plan.
 */
export async function createPlan(ports: CreatePlanPorts, config: Config, discovered: PlanInput, out?: string): Promise<CreatedPlan> {
  const aggregate = PlanAggregate.create(config, discovered, ports.clock.now(), ports.ids.hex(4));
  const plan = aggregate.document;
  const path = await ports.plans.write(plan.id, aggregate.serialize(), out);
  await ports.events.publish(events.planCreated({ planId: plan.id, planDigest: plan.digest, candidates: plan.candidates.length, path }));
  return { plan, path };
}

/** LoadPlan use case: read stored text and verify schema and digest. */
export async function loadPlan(ports: { plans: PlanStore }, ref: string, cwd: string): Promise<Plan> {
  return PlanAggregate.parse(await ports.plans.read(ref, cwd)).document;
}
