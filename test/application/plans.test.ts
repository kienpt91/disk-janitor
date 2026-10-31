import { describe, expect, it } from "vitest";
import { createPlan, loadPlan } from "../../src/application/plans.js";
import { PlanAggregate, PlanIntegrityError, PlanInvariantError, type PlanInput } from "../../src/domain/plan/plan.js";
import { dockerInput, fsInput, makeConfig, ROOT } from "../support/builders.js";
import { FakeClock, FakeIds } from "../support/fakes/clock.js";
import { MEMORY_PLANS_DIR, MemoryPlanStore, RecordingEvents } from "../support/fakes/memory-stores.js";

const A = `${ROOT}/alpha/node_modules`;
const B = `${ROOT}/beta/dist`;

function setup() {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const plans = new MemoryPlanStore();
  const events = new RecordingEvents();
  return { clock, ids, plans, events, ports: { clock, ids, plans, events } };
}

const found = (...paths: string[]): PlanInput => ({ fs: paths.map((p) => fsInput(p)), docker: [], reports: [] });

describe("createPlan", () => {
  it("persists the plan under its id and returns it with the written path", async () => {
    const s = setup();
    const { plan, path } = await createPlan(s.ports, makeConfig(), found(A, B));
    expect(plan.id).toBe("plan-20260101T000000Z-00000001");
    expect(path).toBe(`${MEMORY_PLANS_DIR}/${plan.id}.json`);
    expect(s.plans.paths()).toEqual([path]);
    expect(plan.candidates.map((c) => c.id)).toEqual(["c0001", "c0002"]);
  });

  it("what was stored parses back to the returned plan", async () => {
    const s = setup();
    const { plan, path } = await createPlan(s.ports, makeConfig(), found(A, B));
    const stored = PlanAggregate.parse(await s.plans.read(path, "/"));
    expect(stored.document).toEqual(plan);
    expect(stored.digest).toBe(plan.digest);
  });

  it("publishes exactly one plan-created event with id, digest, count and path", async () => {
    const s = setup();
    const { plan, path } = await createPlan(s.ports, makeConfig(), found(A, B));
    expect(s.events.events).toEqual([{ name: "plan-created", data: { planId: plan.id, planDigest: plan.digest, candidates: 2, path } }]);
  });

  it("uses the clock for the creation time and the id source for the id", async () => {
    const s = setup();
    s.clock.advance(5 * 3_600_000 + 123_000);
    const { plan } = await createPlan(s.ports, makeConfig(), found(A));
    expect(plan.createdAt).toBe(s.clock.now());
    expect(plan.id).toBe("plan-20260101T050203Z-00000001");
  });

  it("writes to an explicit output path and reports it in the event", async () => {
    const s = setup();
    const { path, plan } = await createPlan(s.ports, makeConfig(), found(A), "/tmp/out/plan.json");
    expect(path).toBe("/tmp/out/plan.json");
    expect(s.plans.paths()).toEqual(["/tmp/out/plan.json"]);
    expect(s.events.events[0]?.data["path"]).toBe("/tmp/out/plan.json");
    expect(await loadPlan({ plans: s.plans }, "/tmp/out/plan.json", "/")).toEqual(plan);
  });

  it("an empty discovery still produces a plan and an event with zero candidates", async () => {
    const s = setup();
    const { plan } = await createPlan(s.ports, makeConfig(), found());
    expect(plan.candidates).toEqual([]);
    expect(s.events.events[0]?.data["candidates"]).toBe(0);
  });

  it("two plans get distinct ids, files and events", async () => {
    const s = setup();
    const one = await createPlan(s.ports, makeConfig(), found(A));
    const two = await createPlan(s.ports, makeConfig(), found(A));
    expect(one.plan.id).not.toBe(two.plan.id);
    expect(s.plans.paths()).toHaveLength(2);
    expect(s.events.names()).toEqual(["plan-created", "plan-created"]);
  });

  it("includes docker candidates when docker apply is enabled", async () => {
    const s = setup();
    const { plan } = await createPlan(s.ports, makeConfig({ dockerApply: true }), { fs: [fsInput(A)], docker: [dockerInput()], reports: [] });
    expect(plan.candidates.map((c) => c.kind)).toEqual(["fs", "docker"]);
    expect(s.events.events[0]?.data["candidates"]).toBe(2);
  });

  describe("failure paths write and publish nothing", () => {
    const bad: Array<[string, PlanInput, string]> = [
      ["nested candidates", found(A, `${A}/x/node_modules`), "candidates must not be nested"],
      ["duplicate candidates", found(A, A), "duplicate candidate path"],
      ["a candidate outside the roots", found("/home/dev/other/node_modules"), "outside the configured roots"],
      ["a protected candidate", found(`${ROOT}/app/.git/x`), "protected"],
      ["a non-canonical path", found("relative/node_modules"), "not canonical"],
      ["a negative size", { fs: [fsInput(A, { size: -5 })], docker: [], reports: [] }, "cannot be negative"],
      ["docker candidates without docker apply", { fs: [], docker: [dockerInput()], reports: [] }, "docker apply"],
    ];

    it.each(bad)("%s", async (_n, input, message) => {
      const s = setup();
      await expect(createPlan(s.ports, makeConfig(), input)).rejects.toThrow(PlanInvariantError);
      await expect(createPlan(s.ports, makeConfig(), input)).rejects.toThrow(message);
      expect(s.plans.size).toBe(0);
      expect(s.events.events).toEqual([]);
    });
  });

  it("refuses to overwrite an existing output file and publishes nothing for the failed attempt", async () => {
    const s = setup();
    await createPlan(s.ports, makeConfig(), found(A), "/tmp/out/plan.json");
    const before = s.plans.paths();
    await expect(createPlan(s.ports, makeConfig(), found(B), "/tmp/out/plan.json")).rejects.toMatchObject({ code: "EEXIST" });
    expect(s.plans.paths()).toEqual(before);
    expect(s.events.names()).toEqual(["plan-created"]);
  });
});

describe("loadPlan", () => {
  it("loads a stored plan by id", async () => {
    const s = setup();
    const { plan } = await createPlan(s.ports, makeConfig(), found(A, B));
    expect(await loadPlan({ plans: s.plans }, plan.id, "/anywhere")).toEqual(plan);
  });

  it("loads a plan by absolute path and by path relative to the working directory", async () => {
    const s = setup();
    const { plan } = await createPlan(s.ports, makeConfig(), found(A), "/work/plans/p.json");
    expect(await loadPlan({ plans: s.plans }, "/work/plans/p.json", "/elsewhere")).toEqual(plan);
    expect(await loadPlan({ plans: s.plans }, "plans/p.json", "/work")).toEqual(plan);
  });

  it("rejects a plan whose content was modified", async () => {
    const s = setup();
    const { plan, path } = await createPlan(s.ports, makeConfig(), found(A));
    s.plans.seed(path, (await s.plans.read(path, "/")).replace('"size": 4096', '"size": 1'));
    await expect(loadPlan({ plans: s.plans }, plan.id, "/")).rejects.toThrow(PlanIntegrityError);
    await expect(loadPlan({ plans: s.plans }, plan.id, "/")).rejects.toThrow("plan digest mismatch");
  });

  it("rejects text that is not a plan", async () => {
    const s = setup();
    s.plans.seed("/x/not-a-plan.json", "{}");
    await expect(loadPlan({ plans: s.plans }, "/x/not-a-plan.json", "/")).rejects.toThrow(PlanIntegrityError);
  });

  it("rejects a missing plan with the store's error", async () => {
    const s = setup();
    await expect(loadPlan({ plans: s.plans }, "plan-20260101T000000Z-deadbeef", "/")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a plan that is a symlink", async () => {
    const s = setup();
    s.plans.seedSymlink("/x/link.json");
    await expect(loadPlan({ plans: s.plans }, "/x/link.json", "/")).rejects.toThrow("plan is not a regular file");
  });
});
