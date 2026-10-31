import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplyError, applyPlan } from "../src/apply.js";
import { approvalPath } from "../src/approval.js";
import { verifyAuditText } from "../src/audit.js";
import { acquireLock } from "../src/lock.js";
import { manifestPath, QuarantineError, readManifest } from "../src/quarantine.js";
import { approveAsHuman, makeConfig, makeSandbox, planFor, testDeps, treeHash, writeText, DAY } from "./helpers.js";
import { catchApply, eventNames, fsCandidates, makeThree, readEvents, runApply, storedItem } from "./helpers-apply.js";

describe("apply: basics", () => {
  it("refuses without an approval: nothing moved, audited as apply-refused", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const before = treeHash(sb.projects);
    const p = await planFor(sb);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("not-approved");
    expect(err.message).toContain("no human approval exists for this plan digest");
    expect(treeHash(sb.projects)).toBe(before);
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    const events = await readEvents(p.state);
    expect(eventNames(events)).toEqual(["apply-refused"]);
    expect(events[0]?.data["planId"]).toBe(p.plan.id);
    expect(existsSync(join(p.state.quarantineDir, p.plan.id))).toBe(false);
  });

  it("with approval moves every fs candidate into quarantine items by rename", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    const cands = fsCandidates(p.plan);
    expect(cands.map((c) => c.path)).toEqual(nms);
    const hashes = cands.map((c) => treeHash(c.path));
    await approveAsHuman(p.state, p.plan, p.deps);
    const res = await runApply(p);
    expect(res.moved.map((m) => m.path)).toEqual(nms);
    expect(res.quarantineDir).toBe(join(p.state.quarantineDir, p.plan.id));
    expect(res.docker).toEqual([]);
    cands.forEach((c, i) => {
      expect(existsSync(c.path)).toBe(false);
      const stored = storedItem(p.state, p.plan, i);
      expect(stored).toBe(join(res.quarantineDir, "items", String(i + 1).padStart(4, "0")));
      expect(treeHash(stored)).toBe(hashes[i]);
      // a rename keeps the inode: proof that nothing was copied and deleted
      const st = lstatSync(stored, { bigint: true });
      expect(st.ino.toString()).toBe(c.ino);
      expect(st.dev.toString()).toBe(c.dev);
    });
    // everything that is not a candidate is untouched
    for (const proj of ["p1", "p2", "p3"]) {
      expect(readFileSync(join(sb.projects, proj, "package.json"), "utf8")).toBe('{"name":"p","version":"1.0.0"}\n');
      expect(existsSync(join(sb.projects, proj, "src", "index.js"))).toBe(true);
    }
  });

  it("writes an authenticated manifest that rejects modification", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    await runApply(p);
    const m = await readManifest(p.state, p.plan.id);
    expect(m).not.toBeNull();
    expect(m?.planDigest).toBe(p.plan.digest);
    expect(m?.roots).toEqual(p.config.roots);
    expect(m?.entries.map((e) => [e.stored, e.originalPath, e.status, e.detector])).toEqual([
      ["0001", nms[0], "quarantined", "node-modules"],
      ["0002", nms[1], "quarantined", "node-modules"],
      ["0003", nms[2], "quarantined", "node-modules"],
    ]);
    const file = manifestPath(p.state, p.plan.id);
    const text = readFileSync(file, "utf8");
    const edited = text.replace(/"size": (\d+)/, (_all, n: string) => `"size": ${Number(n) + 1}`);
    expect(edited).not.toBe(text);
    writeFileSync(file, edited);
    await expect(readManifest(p.state, p.plan.id)).rejects.toThrow(QuarantineError);
    await expect(readManifest(p.state, p.plan.id)).rejects.toThrow(/signature is invalid/);
  });

  it("records the audit events in order and the hash chain verifies", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    await runApply(p);
    const events = await readEvents(p.state);
    expect(eventNames(events)).toEqual([
      "approval-issued",
      "approval-consumed",
      "apply-start",
      "quarantine-begin",
      "quarantine-done",
      "quarantine-begin",
      "quarantine-done",
      "quarantine-begin",
      "quarantine-done",
      "apply-complete",
    ]);
    const done = events.filter((e) => e.event === "quarantine-done").map((e) => e.data["path"]);
    expect(done).toEqual(fsCandidates(p.plan).map((c) => c.path));
    const text = readFileSync(p.state.auditPath, "utf8");
    const v = verifyAuditText(text);
    expect(v.ok).toBe(true);
    expect(v.count).toBe(10);
    expect(events.at(-1)?.data).toMatchObject({ planId: p.plan.id, moved: 3, docker: 0 });
  });

  it("an approval is single use: the second apply is refused and moves nothing", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    await runApply(p);
    expect(existsSync(approvalPath(p.state, p.plan.digest))).toBe(false);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("not-approved");
  });

  it("a copied approval file cannot be replayed after it was consumed", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const saved = readFileSync(approvalPath(p.state, p.plan.digest), "utf8");
    await runApply(p);
    writeFileSync(approvalPath(p.state, p.plan.digest), saved, { mode: 0o600 });
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("not-approved");
    expect(err.message).toContain("approval was already used");
  });

  it("an approval for another plan does not authorize this one", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const a = await planFor(sb);
    const b = await planFor(sb);
    expect(a.plan.id).not.toBe(b.plan.id);
    expect(a.plan.digest).not.toBe(b.plan.digest);
    await approveAsHuman(a.state, a.plan, a.deps);
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(b));
    expect(err.code).toBe("not-approved");
    expect(treeHash(sb.projects)).toBe(before);
    // approval record for plan A is renamed to plan B's digest: the binding inside the record catches it
    writeFileSync(approvalPath(b.state, b.plan.digest), readFileSync(approvalPath(a.state, a.plan.digest), "utf8"), { mode: 0o600 });
    const err2 = await catchApply(runApply(b));
    expect(err2.code).toBe("not-approved");
    expect(err2.message).toContain("approval was issued for a different plan");
    expect(treeHash(sb.projects)).toBe(before);
  });

  it("an edited approval record fails its signature", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    const rec = await approveAsHuman(p.state, p.plan, p.deps);
    const file = approvalPath(p.state, p.plan.digest);
    writeFileSync(file, readFileSync(file, "utf8").replace(String(rec.expiresAt), String(rec.expiresAt + 1000)));
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("not-approved");
    expect(err.message).toContain("approval signature is invalid");
  });

  it("an expired approval is refused (injected clock)", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const T = Date.now();
    const p = await planFor(sb, {}, testDeps({ now: () => T }));
    await approveAsHuman(p.state, p.plan, p.deps, 1000);
    const later = { ...p.deps, now: () => T + 1000 };
    const err = await catchApply(runApply(p, later));
    expect(err.code).toBe("not-approved");
    expect(err.message).toContain("approval has expired");
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    // one millisecond earlier it would still have been valid
    const ok = { ...p.deps, now: () => T + 999 };
    const res = await runApply(p, ok);
    expect(res.moved).toHaveLength(3);
  });

  it("refuses when the thresholds differ from the planned configuration", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const other = await makeConfig(sb, { minSizeBytes: 2 });
    const err = await catchApply(applyPlan({ config: other, state: p.state, plan: p.plan, deps: p.deps }));
    expect(err.code).toBe("config-mismatch");
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    expect(existsSync(approvalPath(p.state, p.plan.digest))).toBe(true);
  });

  it("refuses when the roots differ from the planned configuration", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const otherRoot = join(sb.home, "elsewhere");
    mkdirSync(otherRoot);
    const other = await makeConfig(sb, { roots: [otherRoot] });
    const err = await catchApply(applyPlan({ config: other, state: p.state, plan: p.plan, deps: p.deps }));
    expect(err.code).toBe("config-mismatch");
    expect(err.message).toContain("re-run plan");
  });

  it("refuses a plan older than 24 hours even with a fresh approval", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const T = Date.now();
    const p = await planFor(sb, {}, testDeps({ now: () => T }));
    const late = { ...p.deps, now: () => T + DAY + 1 };
    await approveAsHuman(p.state, p.plan, late);
    const err = await catchApply(runApply(p, late));
    expect(err.code).toBe("plan-too-old");
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    // exactly 24 hours is still accepted
    const edge = { ...p.deps, now: () => T + DAY };
    await approveAsHuman(p.state, p.plan, edge);
    expect((await runApply(p, edge)).moved).toHaveLength(3);
  });

  it("refuses to run on a corrupted audit log and moves nothing", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const before = treeHash(sb.projects);
    appendFileSync(p.state.auditPath, '{"seq":99,"garbage":true}\n');
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("audit");
    expect(err.message).toContain("audit log is corrupt at line 2");
    expect(treeHash(sb.projects)).toBe(before);
    for (const nm of nms) expect(existsSync(nm)).toBe(true);
    expect(existsSync(approvalPath(p.state, p.plan.digest))).toBe(true);
  });

  it("refuses when an edited audit entry breaks the hash chain", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const text = readFileSync(p.state.auditPath, "utf8");
    writeFileSync(p.state.auditPath, text.replace("approval-issued", "approval-isssued"));
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("audit");
    expect(err.message).toContain("hash mismatch");
  });

  it("refuses while another operation holds the lock", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const lock = await acquireLock(p.state.lockPath, { timeoutMs: 0 });
    try {
      const err = await catchApply(runApply(p));
      expect(err.code).toBe("locked");
      expect(err.message).toContain("holds the lock");
      for (const nm of nms) expect(existsSync(nm)).toBe(true);
    } finally {
      await lock.release();
    }
    // once released the same approval still works: the refused attempt did not burn it
    expect((await runApply(p)).moved).toHaveLength(3);
    expect(existsSync(p.state.lockPath)).toBe(false);
  });

  it("releases the lock after a failed apply", async () => {
    const sb = makeSandbox();
    makeThree(sb);
    const p = await planFor(sb);
    await catchApply(runApply(p));
    expect(existsSync(p.state.lockPath)).toBe(false);
  });

  it("applying the same plan twice fails with an io error once its quarantine exists", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    await runApply(p);
    const items = nms.map((_, i) => treeHash(storedItem(p.state, p.plan, i)));
    await approveAsHuman(p.state, p.plan, p.deps);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("io");
    expect(err.message).toContain("already applied?");
    nms.forEach((_, i) => expect(treeHash(storedItem(p.state, p.plan, i))).toBe(items[i]));
    const m = await readManifest(p.state, p.plan.id);
    expect(m?.entries.every((e) => e.status === "quarantined")).toBe(true);
  });

  it("an empty plan applies cleanly, creates no quarantine and is audited complete", async () => {
    const sb = makeSandbox();
    writeText(join(sb.projects, "notes", "readme.txt"), "nothing to clean\n");
    const p = await planFor(sb);
    expect(p.plan.candidates).toEqual([]);
    await approveAsHuman(p.state, p.plan, p.deps);
    const res = await runApply(p);
    expect(res.moved).toEqual([]);
    expect(existsSync(join(p.state.quarantineDir, p.plan.id))).toBe(false);
    expect(eventNames(await readEvents(p.state))).toEqual(["approval-issued", "approval-consumed", "apply-start", "apply-complete"]);
  });

  it("never touches projects that are not candidates (fresh project keeps its node_modules)", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const fresh = join(sb.projects, "fresh");
    writeText(join(fresh, "package.json"), "{}\n");
    writeText(join(fresh, "package-lock.json"), "{}\n");
    writeText(join(fresh, "node_modules", "dep", "index.js"), "x\n");
    const freshHash = treeHash(fresh);
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path)).toEqual(nms);
    await approveAsHuman(p.state, p.plan, p.deps);
    await runApply(p);
    expect(treeHash(fresh)).toBe(freshHash);
  });
});

describe("apply: all or nothing", () => {
  const mutations: Array<[string, (nm: string) => void]> = [
    ["a file added inside", (nm) => writeText(join(nm, "dep", "added.js"), "late\n")],
    [
      "the directory mtime touched",
      (nm) => {
        const t = new Date(Date.now() + 5000);
        utimesSync(nm, t, t);
      },
    ],
    ["a file grown (size changed)", (nm) => appendFileSync(join(nm, "dep", "index.js"), "z".repeat(20_000))],
    ["deleted", (nm) => rmSync(nm, { recursive: true })],
    [
      "replaced by a regular file",
      (nm) => {
        rmSync(nm, { recursive: true });
        writeFileSync(nm, "not a directory any more");
      },
    ],
  ];

  it.each(mutations)("last candidate %s: aborts with validation, nothing moved, quarantine cleaned up", async (_name, mutate) => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path)).toEqual(nms);
    await approveAsHuman(p.state, p.plan, p.deps);
    const firstTwo = nms.slice(0, 2).map((nm) => treeHash(nm));
    mutate(nms[2] as string);
    const afterMutation = treeHash(sb.projects);

    const err = await catchApply(runApply(p));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("nothing was changed");
    expect(err.problems.some((x) => x.includes(nms[2] as string))).toBe(true);
    expect(err.problems.some((x) => x.includes(nms[0] as string) || x.includes(nms[1] as string))).toBe(false);

    expect(treeHash(sb.projects)).toBe(afterMutation);
    expect([nms[0], nms[1]].map((nm) => treeHash(nm as string))).toEqual(firstTwo);
    expect(existsSync(join(p.state.quarantineDir, p.plan.id))).toBe(false);
    const events = eventNames(await readEvents(p.state));
    expect(events).toContain("apply-aborted");
    expect(events).not.toContain("quarantine-begin");
    const aborted = (await readEvents(p.state)).find((e) => e.event === "apply-aborted");
    expect(aborted?.data["problems"]).toEqual(err.problems);
  });

  it("mutating the first candidate also aborts before anything moves", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    writeText(join(nms[0] as string, "dep", "late.js"), "x\n");
    const afterMutation = treeHash(sb.projects);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(1);
    expect(treeHash(sb.projects)).toBe(afterMutation);
    expect(existsSync(nms[1] as string) && existsSync(nms[2] as string)).toBe(true);
  });

  it("every drifted candidate is listed in the problems", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    writeText(join(nms[0] as string, "dep", "late.js"), "x\n");
    rmSync(nms[2] as string, { recursive: true });
    const err = await catchApply(runApply(p));
    expect(err.problems).toHaveLength(2);
    expect(err.problems.some((x) => x.includes(nms[0] as string))).toBe(true);
    expect(err.problems.some((x) => x.includes(nms[2] as string))).toBe(true);
  });

  it("an aborted apply still consumed the approval (a new approval is needed after re-planning)", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    writeText(join(nms[2] as string, "dep", "late.js"), "x\n");
    await catchApply(runApply(p));
    expect(existsSync(approvalPath(p.state, p.plan.digest))).toBe(false);
    const events = eventNames(await readEvents(p.state));
    expect(events.indexOf("approval-consumed")).toBeLessThan(events.indexOf("apply-aborted"));
    // a fresh plan reflects the new state and applies fine
    const q = await planFor(sb);
    await approveAsHuman(q.state, q.plan, q.deps);
    const res = await runApply(q);
    // the modified project is no longer stale, so the fresh plan leaves it alone
    expect(res.moved.map((m) => m.path)).toEqual([nms[0], nms[1]]);
    expect(existsSync(nms[2] as string)).toBe(true);
  });

  it("a candidate that became newer than the plan is refused (modified after plan time)", async () => {
    const sb = makeSandbox();
    const { nms } = makeThree(sb);
    const T = Date.now();
    // plan made "in the past": the candidates look newer than the plan when checked
    const p = await planFor(sb, {}, testDeps({ now: () => T }));
    await approveAsHuman(p.state, p.plan, p.deps);
    const mid = new Date(T + 10_000);
    utimesSync(nms[1] as string, mid, mid);
    const err = await catchApply(runApply(p));
    expect(err.problems.some((x) => x.includes(nms[1] as string) && x.includes("modified after the plan"))).toBe(true);
  });

  it("ApplyError carries its code and problems", () => {
    const e = new ApplyError("validation", "msg", ["a", "b"]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApplyError");
    expect(e.code).toBe("validation");
    expect(e.problems).toEqual(["a", "b"]);
    expect(new ApplyError("io", "x").problems).toEqual([]);
  });
});
