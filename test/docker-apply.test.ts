import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/apply.js";
import { DOCKER_COMMANDS } from "../src/detectors/docker.js";
import { computePlanDigest } from "../src/plan.js";
import type { DockerCandidate, Plan } from "../src/types.js";
import { approveAsHuman, makeSandbox, planFor, testDeps, treeHash, writeText } from "./helpers.js";
import type { CommandResult } from "../src/deps.js";
import { catchApply, eventNames, fsCandidates, makeThree, readEvents, runApply } from "./helpers-apply.js";

const DF = [
  JSON.stringify({ Type: "Images", TotalCount: 4, Active: 1, Size: "500MB", Reclaimable: "100MB (20%)" }),
  JSON.stringify({ Type: "Containers", TotalCount: 1, Active: 1, Size: "10MB", Reclaimable: "0B" }),
  JSON.stringify({ Type: "Local Volumes", TotalCount: 3, Active: 1, Size: "9GB", Reclaimable: "8GB (88%)" }),
  JSON.stringify({ Type: "Build Cache", TotalCount: 5, Active: 0, Size: "2GB", Reclaimable: "1.5GB" }),
].join("\n");

type DockerHandler = (args: readonly string[]) => Partial<CommandResult>;

function dockerHandler(opts: { failBuild?: boolean; failImage?: boolean; onPrune?: (args: readonly string[]) => void } = {}): DockerHandler {
  return (args) => {
    const line = args.join(" ");
    if (line === DOCKER_COMMANDS.df.join(" ")) return { stdout: DF };
    if (line === DOCKER_COMMANDS.danglingImages.join(" ")) return { stdout: JSON.stringify({ Size: "120MB" }) + "\n" };
    if (line === DOCKER_COMMANDS.pruneBuildCache.join(" ")) {
      opts.onPrune?.(args);
      return opts.failBuild ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : { stdout: "Total reclaimed space: 1.5GB" };
    }
    if (line === DOCKER_COMMANDS.pruneDanglingImages.join(" ")) {
      opts.onPrune?.(args);
      return opts.failImage ? { code: 1, stderr: "image prune failed" } : { stdout: "Total reclaimed space: 120MB" };
    }
    return { code: 125, stderr: `unexpected docker arguments: ${line}` };
  };
}

const isPrune = (args: readonly string[]): boolean => args.includes("prune");

function dockerCalls(deps: { calls: Array<{ command: string; args: readonly string[] }> }, from = 0): string[][] {
  return deps.calls
    .slice(from)
    .filter((c) => c.command === "docker")
    .map((c) => [...c.args]);
}

describe("docker apply", () => {
  it("runs exactly the two fixed prune commands, in order, after approval", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    expect(p.plan.candidates.filter((c) => c.kind === "docker").map((c) => (c as DockerCandidate).resource)).toEqual(["build-cache", "dangling-images"]);
    await approveAsHuman(p.state, p.plan, deps);
    const mark = deps.calls.length;
    const res = await runApply(p);
    const calls = dockerCalls(deps, mark);
    expect(calls).toEqual([[...DOCKER_COMMANDS.pruneBuildCache], [...DOCKER_COMMANDS.pruneDanglingImages]]);
    expect(calls).toEqual([["builder", "prune", "--force"], ["image", "prune", "--force"]]);
    expect(res.docker.map((d) => [d.resource, d.ok])).toEqual([
      ["build-cache", true],
      ["dangling-images", true],
    ]);
    expect(res.docker[0]?.detail).toBe("Total reclaimed space: 1.5GB");
    expect(res.moved.map((m) => m.path)).toEqual(nms);
  });

  it("never sends volume, --all, -a or --volumes arguments anywhere in a full plan/apply run", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(p.state, p.plan, deps);
    await runApply(p);
    const all = dockerCalls(deps);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const args of all) {
      for (const a of args) {
        expect(a).not.toMatch(/^(volume|--all|-a|--volumes|-af|-fa|rm|rmi|stop|kill|exec|run)$/);
      }
      expect(args.join(" ")).not.toContain("volume");
    }
    // every call is one of the four fixed argument lists
    const allowed = Object.values(DOCKER_COMMANDS).map((c) => c.join("\u0000"));
    for (const args of all) expect(allowed).toContain(args.join("\u0000"));
    // prune commands carry nothing but --force
    for (const args of all.filter(isPrune)) expect(args).toHaveLength(3);
  });

  it("zero docker prune calls without an approval", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    const mark = deps.calls.length;
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("not-approved");
    expect(dockerCalls(deps, mark)).toEqual([]);
    expect(treeHash(sb.projects)).toBe(before);
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
  });

  it("zero docker calls when the approval is for a different plan or expired", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const T = Date.now();
    const deps = testDeps({ docker: dockerHandler(), now: () => T });
    const a = await planFor(sb, { dockerApply: true }, deps);
    const b = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(a.state, a.plan, deps);
    const mark = deps.calls.length;
    expect((await catchApply(runApply(b))).code).toBe("not-approved");
    await approveAsHuman(b.state, b.plan, deps, 1000);
    const late = { ...deps, now: () => T + 1000 };
    expect((await catchApply(runApply(b, late))).code).toBe("not-approved");
    expect(dockerCalls(deps, mark)).toEqual([]);
  });

  it("a prune failure is reported with ok:false, audited, and the fs moves are kept", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler({ failBuild: true }) });
    const p = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(p.state, p.plan, deps);
    const mark = deps.calls.length;
    const res = await runApply(p);
    expect(res.moved.map((m) => m.path)).toEqual(nms);
    for (const nm of nms) expect(existsSync(nm)).toBe(false);
    expect(res.docker.map((d) => [d.resource, d.ok])).toEqual([
      ["build-cache", false],
      ["dangling-images", true],
    ]);
    expect(res.docker[0]?.detail).toBe("Cannot connect to the Docker daemon");
    // the second prune still ran with its fixed arguments
    expect(dockerCalls(deps, mark)).toEqual([[...DOCKER_COMMANDS.pruneBuildCache], [...DOCKER_COMMANDS.pruneDanglingImages]]);
    const events = await readEvents(p.state);
    const done = events.filter((e) => e.event === "docker-prune-done");
    expect(done.map((e) => [e.data["resource"], e.data["ok"]])).toEqual([
      ["build-cache", false],
      ["dangling-images", true],
    ]);
    expect(done[0]?.data["detail"]).toBe("Cannot connect to the Docker daemon");
    expect(eventNames(events).at(-1)).toBe("apply-complete");
    expect(events.at(-1)?.data).toMatchObject({ moved: 3, docker: 2 });
  });

  it("a docker CLI that is gone at apply time is a failed prune, not an exception", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const scanDeps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, scanDeps);
    await approveAsHuman(p.state, p.plan, scanDeps);
    const gone = testDeps({ docker: () => undefined });
    const res = await runApply(p, gone);
    expect(res.moved).toHaveLength(3);
    expect(res.docker.map((d) => d.ok)).toEqual([false, false]);
    expect(res.docker[0]?.detail).toBe("ENOENT");
  });

  it("a plan with docker candidates but dockerApply disabled is refused and calls docker zero times", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, {}, deps);
    expect(p.config.dockerApply).toBe(false);
    expect(p.plan.candidates.some((c) => c.kind === "docker")).toBe(false);
    const evil: Plan = structuredClone(p.plan);
    evil.candidates.push({
      kind: "docker",
      id: "c0099",
      detector: "docker",
      resource: "build-cache",
      size: 1,
      reason: "injected",
      regenerate: "n/a",
    });
    evil.digest = computePlanDigest(evil);
    await approveAsHuman(p.state, evil, deps);
    const mark = deps.calls.length;
    const before = treeHash(sb.projects);
    const err = await catchApply(applyPlan({ config: p.config, state: p.state, plan: evil, deps }));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("docker apply is not enabled");
    expect(dockerCalls(deps, mark)).toEqual([]);
    // the fs candidates of the same plan were not moved either, and no quarantine was created
    expect(treeHash(sb.projects)).toBe(before);
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    expect(existsSync(`${p.state.quarantineDir}/${evil.id}`)).toBe(false);
    expect((await readEvents(p.state)).some((e) => e.event === "apply-aborted")).toBe(true);
  });

  it("the plan scan without dockerApply reports docker usage but offers no candidate", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { detectors: ["node-modules", "docker"] }, deps);
    expect(p.plan.candidates.every((c) => c.kind === "fs")).toBe(true);
    expect(p.plan.reports.some((r) => r.detector === "docker")).toBe(true);
    expect(dockerCalls(deps).some(isPrune)).toBe(false);
  });

  it("docker candidates run only after the fs quarantine succeeded", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const seenAtPrune: boolean[][] = [];
    const deps = testDeps({
      docker: dockerHandler({
        onPrune: () => seenAtPrune.push(nms.map((nm) => existsSync(nm))),
      }),
    });
    const p = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(p.state, p.plan, deps);
    await runApply(p);
    expect(seenAtPrune).toEqual([
      [false, false, false],
      [false, false, false],
    ]);
    const names = eventNames(await readEvents(p.state));
    const lastDone = names.lastIndexOf("quarantine-done");
    expect(names.indexOf("docker-prune-begin")).toBeGreaterThan(lastDone);
    expect(names.filter((n) => n === "docker-prune-begin")).toHaveLength(2);
  });

  it("docker prune does not run when file system validation aborts the apply", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(p.state, p.plan, deps);
    writeText(`${nms[2]}/dep/late.js`, "changed after plan\n");
    const mark = deps.calls.length;
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("validation");
    expect(dockerCalls(deps, mark)).toEqual([]);
    const names = eventNames(await readEvents(p.state));
    expect(names).toContain("apply-aborted");
    expect(names).not.toContain("docker-prune-begin");
  });

  it("docker prune does not run when a rename fails and the moves are rolled back", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    await approveAsHuman(p.state, p.plan, deps);
    const failing = { ...deps, fs: { ...deps.fs, rename: (from: string, to: string) => (from === nms[1] ? Promise.reject(Object.assign(new Error("x"), { code: "EXDEV" })) : deps.fs.rename(from, to)) } };
    const mark = deps.calls.length;
    const err = await catchApply(runApply(p, failing));
    expect(err.code).toBe("io");
    expect(dockerCalls(deps, mark)).toEqual([]);
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
  });

  it("a docker-only plan (no fs candidates) applies without touching the quarantine", async () => {
    const sb = makeSandbox();
    writeText(`${sb.projects}/notes/readme.txt`, "no cleanup targets\n");
    const deps = testDeps({ docker: dockerHandler() });
    const p = await planFor(sb, { dockerApply: true }, deps);
    expect(fsCandidates(p.plan)).toEqual([]);
    expect(p.plan.candidates).toHaveLength(2);
    await approveAsHuman(p.state, p.plan, deps);
    const res = await runApply(p);
    expect(res.moved).toEqual([]);
    expect(res.docker.map((d) => d.ok)).toEqual([true, true]);
    expect(existsSync(`${p.state.quarantineDir}/${p.plan.id}`)).toBe(false);
  });
});
