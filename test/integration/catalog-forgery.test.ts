import { existsSync, lstatSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectTree } from "../../src/application/inspect-tree.js";
import { ApplyError } from "../../src/composition/disposal.js";
import type { FsCandidate, Plan } from "../../src/domain/model/types.js";
import { nodeFs } from "../../src/infrastructure/fs/node-fs.js";
import { approveAsHuman, makeProject, makeSandbox, planFor, treeHash, writeText } from "../support/helpers.js";
import { catchApply, eventNames, fsCandidates, readEvents, retarget, runApply } from "../support/helpers-apply.js";

/** Describe `path` as a Candidate exactly as the plan format records it (what a forger can compute). */
async function describeDir(path: string, template: FsCandidate, detector: FsCandidate["detector"]): Promise<FsCandidate> {
  const st = lstatSync(path, { bigint: true });
  const tree = await inspectTree(nodeFs, path, await nodeFs.lstat(path), { dev: st.dev, maxEntries: 1_000_000, strict: false });
  if (!tree.ok) throw new Error(tree.reason);
  return { ...template, detector, path, dev: st.dev.toString(), ino: st.ino.toString(), size: tree.stats.size, entries: tree.stats.entries, mtimeMs: Number(st.mtimeMs), newestMtimeMs: tree.stats.newestMtimeMs };
}

async function forgedPlan(plan: Plan, path: string, detector: FsCandidate["detector"]): Promise<Plan> {
  const forged = await describeDir(path, fsCandidates(plan)[0] as FsCandidate, detector);
  return retarget(plan, (cands) => void Object.assign(cands[0] as FsCandidate, forged));
}

describe("apply: a forged plan cannot name directories discovery would never offer", () => {
  it("refuses <root>/app/notes (valid digest, human approval): ApplyError validation, directory untouched, nothing quarantined", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 20_000 });
    writeText(join(app, "notes", "todo.txt"), "precious\n");
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(join(app, "notes", "todo.txt"), old, old);
    utimesSync(join(app, "notes"), old, old);
    const p = await planFor(sb);
    const plan = await forgedPlan(p.plan, join(app, "notes"), "node-modules");
    const before = treeHash(sb.projects);
    await approveAsHuman(p.state, plan, p.deps);
    const err = await catchApply(runApply({ ...p, plan }));
    expect(err).toBeInstanceOf(ApplyError);
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([`c0001 ${join(app, "notes")}: not a catalogue item: its name is not node_modules`]);
    expect(treeHash(sb.projects)).toBe(before);
    expect(existsSync(join(app, "notes", "todo.txt"))).toBe(true);
    expect(existsSync(join(p.state.quarantineDir, plan.id))).toBe(false);
    expect(eventNames(await readEvents(p.state))).toEqual(["approval-issued", "approval-consumed", "apply-start", "apply-aborted"]);
  });

  it("refuses a node_modules-named directory whose project has no package.json or lockfile", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 20_000 });
    writeText(join(sb.projects, "stray", "node_modules", "x.txt"), "x\n");
    const p = await planFor(sb);
    const plan = await forgedPlan(p.plan, join(sb.projects, "stray", "node_modules"), "node-modules");
    await approveAsHuman(p.state, plan, p.deps);
    const err = await catchApply(runApply({ ...p, plan }));
    expect(err.problems[0]).toContain("no package.json next to it");
    expect(existsSync(join(sb.projects, "stray", "node_modules", "x.txt"))).toBe(true);
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("refuses a build-output directory without a manifest or .git; genuine candidates are still applied", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 20_000 });
    mkdirSync(join(sb.projects, "loose", "dist"), { recursive: true });
    writeFileSync(join(sb.projects, "loose", "dist", "a.js"), "x");
    const p = await planFor(sb);
    const forged = await forgedPlan(p.plan, join(sb.projects, "loose", "dist"), "build-output");
    await approveAsHuman(p.state, forged, p.deps);
    const err = await catchApply(runApply({ ...p, plan: forged }));
    expect(err.problems[0]).toMatch(/not a catalogue item: no sibling manifest identifies the project type and no \.git entry was found/);
    expect(existsSync(join(sb.projects, "loose", "dist", "a.js"))).toBe(true);

    // the unmodified plan (discovery's own candidates) is accepted
    await approveAsHuman(p.state, p.plan, p.deps);
    const ok = await runApply(p);
    expect(ok.moved.map((m) => m.path)).toEqual([join(app, "node_modules")]);
  });
});
