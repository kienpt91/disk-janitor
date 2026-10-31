import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { scan } from "../src/scan.js";
import { applyPlan } from "../src/apply.js";
import { approveAsHuman, makeConfig, makeMixedTree, makeSandbox, planFor, testDeps, treeHash } from "./helpers.js";

describe("smoke: mixed tree end to end", () => {
  it("scan finds the expected candidates and skips the unsafe ones", async () => {
    const sb = makeSandbox();
    const t = makeMixedTree(sb);
    const deps = testDeps();
    const result = await scan(await makeConfig(sb, {}, deps), deps);
    const paths = result.fs.map((c) => c.path).sort();
    expect(paths).toEqual(
      [join(t.webapp, "node_modules"), join(t.webapp, "dist"), join(t.api, "node_modules"), join(t.api, "target")].sort(),
    );
  });

  it("approve then apply moves candidates into quarantine and leaves the rest alone", async () => {
    const sb = makeSandbox();
    const t = makeMixedTree(sb);
    const before = treeHash(t.fresh);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const res = await applyPlan({ config: p.config, state: p.state, plan: p.plan, deps: p.deps });
    expect(res.moved).toHaveLength(4);
    expect(treeHash(t.fresh)).toBe(before);
  });
});
