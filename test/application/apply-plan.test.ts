import { beforeEach, describe, expect, it } from "vitest";
import { ApplyError, revalidate } from "../../src/application/apply-plan.js";
import { MAX_PLAN_AGE_MS } from "../../src/domain/plan/plan.js";
import { QuarantineError } from "../../src/domain/quarantine/errors.js";
import { makeConfig } from "../support/builders.js";
import { DisposalWorld, errno, HOME, QUARANTINE_ROOT, ROOT, wrapFs } from "../support/disposal-world.js";

let w: DisposalWorld;
beforeEach(() => {
  w = new DisposalWorld();
});

async function failure(p: Promise<unknown>): Promise<ApplyError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApplyError) return e;
    throw e;
  }
  throw new Error("expected an ApplyError");
}

/** Three projects with node_modules of decreasing size; returns their node_modules paths. */
function three(): string[] {
  return [w.project("a", 12_000), w.project("b", 8_000), w.project("c", 4_000)];
}

const stateOf = (path: string): string => (w.fs.exists(path) ? "present" : "absent");

describe("ApplyPlan: the happy path", () => {
  it("moves every candidate into quarantine with rename, keeping the directory identity", async () => {
    const nms = three();
    const before = await Promise.all(nms.map((p) => w.fs.lstat(p)));
    const { plan, result } = await w.applied(nms);
    expect(result.planId).toBe(plan.id);
    expect(result.quarantineDir).toBe(`${QUARANTINE_ROOT}/${plan.id}`);
    expect(result.moved).toEqual(plan.candidates.map((c) => ({ id: c.id, path: c.kind === "fs" ? c.path : "", size: c.size })));
    expect(result.docker).toEqual([]);
    for (let i = 0; i < nms.length; i++) {
      expect(stateOf(nms[i] as string)).toBe("absent");
      const landed = await w.fs.lstat(w.itemPath(plan, i + 1));
      expect(landed.ino).toBe((before[i] as { ino: bigint }).ino);
      expect(landed.dev).toBe((before[i] as { dev: bigint }).dev);
    }
    expect(w.fs.renames.map(([from, to]) => [from, to])).toEqual(nms.map((p, i) => [p, w.itemPath(plan, i + 1)]));
  });

  it("publishes the events in audit order", async () => {
    const nms = three();
    const { plan } = await w.applied(nms);
    expect(await w.eventNames()).toEqual([
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
    const events = await w.events();
    expect(events[0]?.data).toMatchObject({ planId: plan.id, planDigest: plan.digest });
    expect(events[1]?.data).toEqual({ planId: plan.id, planDigest: plan.digest, fs: 3 });
    expect(events[2]?.data).toEqual({ planId: plan.id, id: "c0001", path: nms[0], size: plan.candidates[0]?.size });
    expect(events[8]?.data).toEqual({ planId: plan.id, moved: 3, docker: 0 });
  });

  it("writes an authenticated manifest with every entry quarantined at the clock time", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.clock.advance(5_000);
    await w.apply(plan);
    const m = await w.quarantine.load(plan.id);
    expect(m?.planDigest).toBe(plan.digest);
    expect(m?.createdAt).toBe(w.clock.now());
    expect(m?.scope).toEqual({ roots: [ROOT], home: HOME, detectors: w.config.detectors });
    expect(m?.entries.map((e) => [e.stored, e.status, e.quarantinedAt, e.originalPath])).toEqual(nms.map((p, i) => [`000${i + 1}`, "quarantined", w.clock.now(), p]));
  });

  it("spends the approval: it is removed and cannot be reused", async () => {
    const { plan } = await w.applied([w.project("a")]);
    expect(w.approvals.size).toBe(0);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("not-approved");
    expect(e.message).toContain("no human approval exists for this plan digest");
  });

  it("an approval file copied before the apply is refused as already used (replay)", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    const copy = (await w.approvals.read(plan.digest)) as string;
    await w.apply(plan);
    await w.approvals.write(plan.digest, copy);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("not-approved");
    expect(e.message).toBe(`apply refused: approval was already used. A human must run 'disk-janitor approve ${plan.id}' in a terminal`);
    expect((await w.events()).filter((x) => x.name === "apply-refused")).toEqual([
      { name: "apply-refused", data: { planId: plan.id, planDigest: plan.digest, reason: "approval was already used" } },
    ]);
  });

  it("releases the lock when it is done", async () => {
    await w.applied([w.project("a")]);
    expect(w.lockState.holder).toBeNull();
  });

  it("an empty plan completes with apply-start (fs 0) and apply-complete and creates no quarantine directory", async () => {
    const plan = await w.plan([]);
    await w.approve(plan);
    const result = await w.apply(plan);
    expect(result.moved).toEqual([]);
    expect(await w.eventNames()).toEqual(["approval-consumed", "apply-start", "apply-complete"]);
    expect(w.fs.list(QUARANTINE_ROOT)).toEqual([]);
  });
});

describe("ApplyPlan: refusals before anything is touched", () => {
  it("refuses a plan made under another configuration", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    const other = makeConfig({ staleDays: 5 });
    const e = await failure(w.apply(plan, {}, other));
    expect(e.code).toBe("config-mismatch");
    expect(e.message).toBe("the active configuration differs from the one the plan was made with; re-run plan");
    expect(await w.eventNames()).toEqual([]);
    expect(w.approvals.size).toBe(1);
    expect(stateOf(nms[0] as string)).toBe("present");
  });

  it("refuses a plan older than 24 hours", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    w.clock.advance(MAX_PLAN_AGE_MS + 1);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("plan-too-old");
    expect(e.message).toBe("the plan is older than 24 hours; re-run plan");
    expect(await w.eventNames()).toEqual([]);
  });

  it("a plan exactly 24 hours old is not too old yet (only its expired approval refuses it)", async () => {
    const plan = await w.plan([w.project("a")]);
    await w.approve(plan);
    w.clock.advance(MAX_PLAN_AGE_MS);
    // the approval (15 minutes) is what refuses now, not the plan age
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("not-approved");
    expect(e.message).toContain("approval has expired");
  });

  it("refuses while another operation holds the lock, and leaves the holder alone", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    const holder = Symbol("other");
    w.lockState.holder = holder;
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("locked");
    expect(e.message).toContain("holds the lock");
    expect(w.lockState.holder).toBe(holder);
    expect(await w.eventNames()).toEqual([]);
    expect(w.approvals.size).toBe(1);
    expect(stateOf(nms[0] as string)).toBe("present");
  });

  it("propagates a lock failure that is not contention", async () => {
    const plan = await w.plan([w.project("a")]);
    const boom = new Error("disk full");
    await expect(w.apply(plan, { lock: { acquire: () => Promise.reject(boom) } })).rejects.toBe(boom);
  });

  it("refuses when the audit log is corrupt, and releases the lock", async () => {
    const plan = await w.plan([w.project("a")]);
    await w.approve(plan);
    w.audit.storage.text = "not json\n";
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("audit");
    expect(e.message).toBe("audit log is corrupt at line 1 (not valid JSON); move audit.jsonl aside after reviewing it");
    expect(w.lockState.holder).toBeNull();
    expect(w.approvals.size).toBe(1);
  });

  it("refuses without a human approval and records apply-refused", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("not-approved");
    expect(await w.events()).toEqual([
      { name: "apply-refused", data: { planId: plan.id, planDigest: plan.digest, reason: "no human approval exists for this plan digest" } },
    ]);
    expect(stateOf(nms[0] as string)).toBe("present");
    expect(w.lockState.holder).toBeNull();
  });

  it("refuses an approval issued for a different plan", async () => {
    const plan = await w.plan([w.project("a")]);
    const other = await w.plan([w.project("b")]);
    await w.approve(other);
    await w.approvals.write(plan.digest, (await w.approvals.read(other.digest)) as string);
    const e = await failure(w.apply(plan));
    expect(e.message).toContain("approval was issued for a different plan");
  });

  it("refuses an approval signed with another key", async () => {
    const plan = await w.plan([w.project("a")]);
    await w.approve(plan);
    w.vault.key = "another-key";
    const e = await failure(w.apply(plan));
    expect(e.message).toContain("approval signature is invalid");
  });

  it("refuses an expired approval", async () => {
    const plan = await w.plan([w.project("a")]);
    await w.approve(plan, 60_000);
    w.clock.advance(60_000);
    expect((await failure(w.apply(plan))).message).toContain("approval has expired");
  });

  it("refuses docker candidates when docker apply is not enabled, after the approval is spent", async () => {
    const plan = await w.plan([], ["build-cache"]);
    await w.approve(plan);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("validation");
    expect(e.message).toBe("the plan contains docker candidates but docker apply is not enabled in the configuration");
    expect(await w.events()).toEqual([
      { name: "approval-consumed", data: expect.objectContaining({ planId: plan.id }) },
      { name: "apply-start", data: { planId: plan.id, planDigest: plan.digest, fs: 0 } },
      { name: "apply-aborted", data: { planId: plan.id, reason: "docker candidates present but docker apply is not enabled" } },
    ]);
    expect(w.docker.pruned).toEqual([]);
  });

  it("refuses to apply into a quarantine directory that already exists", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.fs.mkdir(`${QUARANTINE_ROOT}/${plan.id}`);
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("io");
    expect(e.message).toBe("cannot create the quarantine for this plan (already applied?): EEXIST");
    expect(stateOf(nms[0] as string)).toBe("present");
    expect(w.lockState.holder).toBeNull();
  });
});

describe("ApplyPlan: all-or-nothing validation", () => {
  async function abortedWith(nms: string[], tamper: () => void, plan?: Awaited<ReturnType<typeof w.plan>>) {
    const p = plan ?? (await w.plan(nms));
    await w.approve(p);
    tamper();
    const e = await failure(w.apply(p));
    return { plan: p, e };
  }

  it("a single changed candidate aborts everything: nothing moves, no manifest, no quarantine directory", async () => {
    const nms = three();
    const { plan, e } = await abortedWith(nms, () => w.fs.writeFile(`${nms[1]}/dep/new.js`));
    expect(e.code).toBe("validation");
    expect(e.message).toBe("aborted: the file system no longer matches the plan; nothing was changed");
    expect(e.problems).toEqual([`c0002 ${nms[1]}: contents changed since the plan was made`]);
    for (const p of nms) expect(stateOf(p)).toBe("present");
    expect(w.fs.renames).toEqual([]);
    expect(w.fs.list(QUARANTINE_ROOT)).toEqual([]);
    expect(w.quarantine.texts.size).toBe(0);
    expect(await w.events()).toEqual([
      { name: "approval-consumed", data: expect.objectContaining({ planId: plan.id }) },
      { name: "apply-start", data: { planId: plan.id, planDigest: plan.digest, fs: 3 } },
      { name: "apply-aborted", data: { planId: plan.id, reason: "validation failed", problems: e.problems } },
    ]);
    expect(w.approvals.size).toBe(0);
    expect(w.lockState.holder).toBeNull();
  });

  it("reports the problems of every bad candidate, in plan order", async () => {
    const nms = three();
    const { e } = await abortedWith(nms, () => {
      w.fs.writeFile(`${nms[0]}/dep/new.js`);
      w.fs.remove(nms[2] as string);
    });
    expect(e.problems).toEqual([`c0001 ${nms[0]}: contents changed since the plan was made`, `c0003 ${nms[2]}: cannot inspect the path (ENOENT)`]);
  });

  it("detects a directory replaced by a symlink", async () => {
    const nms = [w.project("a")];
    const { e } = await abortedWith(nms, () => {
      w.fs.mkdir(`${ROOT}/elsewhere`);
      w.fs.remove(nms[0] as string);
      w.fs.symlink(nms[0] as string, `${ROOT}/elsewhere`);
    });
    expect(e.problems).toEqual([`c0001 ${nms[0]}: a symlink or non-directory appeared in the path`]);
  });

  it("detects a parent directory replaced by a symlink", async () => {
    const nms = [w.project("a")];
    const { e } = await abortedWith(nms, () => {
      w.fs.mkdir(`${ROOT}/moved`);
      w.fs.rename(`${ROOT}/a`, `${ROOT}/moved/a`);
      w.fs.symlink(`${ROOT}/a`, `${ROOT}/moved/a`);
    });
    expect(e.problems).toEqual([`c0001 ${nms[0]}: a symlink or non-directory appeared in the path`]);
  });

  it("detects the same path holding a different directory (inode changed)", async () => {
    const nms = [w.project("a")];
    const { e } = await abortedWith(nms, () => {
      w.fs.remove(nms[0] as string);
      w.fs.writeFile(`${nms[0]}/dep/index.js`, { bytes: 4096 });
    });
    expect(e.problems).toEqual([`c0001 ${nms[0]}: device or inode changed since the plan was made`]);
  });

  it("detects a directory modified after the plan was made", async () => {
    const nms = [w.project("a")];
    const { e } = await abortedWith(nms, () => w.fs.setMtime(nms[0] as string, w.clock.now() + 1));
    expect(e.problems).toEqual([`c0001 ${nms[0]}: directory was modified after the plan was made`]);
  });

  it("detects contents newer than the plan", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.fs.setMtime(`${nms[0]}/dep/index.js`, w.clock.now() + 10);
    const e = await failure(w.apply(plan));
    expect(e.problems).toEqual([`c0001 ${nms[0]}: contents changed since the plan was made`]);
  });

  it("refuses a candidate that lives on another file system than the quarantine", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.fs.setDev(QUARANTINE_ROOT, 9n);
    const e = await failure(w.apply(plan));
    expect(e.problems).toEqual([
      `c0001 ${nms[0]}: is on a different file system than the quarantine; rename cannot cross devices and copying is never done`,
    ]);
    expect(stateOf(nms[0] as string)).toBe("present");
  });

  it("refuses a candidate that lives on another file system than its root", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.fs.setDev(ROOT, 9n);
    w.fs.setDev(QUARANTINE_ROOT, 9n);
    const e = await failure(w.apply(plan));
    // dev of the candidate and of its root agree now (both 9); the recorded dev no longer matches
    expect(e.problems).toEqual([`c0001 ${nms[0]}: device or inode changed since the plan was made`]);
  });

  it("a process with a file open inside blocks the apply; with lsof unavailable the check is off", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.openFiles.names = [`${nms[0]}/dep/index.js`];
    const e = await failure(w.apply(plan));
    expect(e.problems).toEqual([`c0001 ${nms[0]}: a process has files open inside it`]);
    expect(w.openFiles.snapshots).toBe(1);

    const w2 = new DisposalWorld();
    const nms2 = [w2.project("a")];
    const plan2 = await w2.plan(nms2);
    await w2.approve(plan2);
    w2.openFiles.names = null;
    await expect(w2.apply(plan2)).resolves.toBeDefined();
  });

  it("an open file elsewhere does not matter", async () => {
    const nms = [w.project("a")];
    w.openFiles.names = [`${ROOT}/a/package.json`, "/tmp/other"];
    await expect(w.applied(nms)).resolves.toBeDefined();
  });

  it("a candidate whose path is outside the configured roots is refused (a forged plan)", async () => {
    w.fs.mkdir("/other/place/node_modules/dep").writeFile("/other/place/node_modules/dep/f.js");
    const plan = await w.plan(["/other/place/node_modules"]);
    await w.approve(plan);
    const e = await failure(w.apply(plan));
    expect(e.problems).toEqual([`c0001 /other/place/node_modules: outside the configured roots`]);
  });

  it("a protected path inside a root is refused", async () => {
    w.fs.writeFile(`${ROOT}/a/.git/objects/x`);
    const plan = await w.plan([`${ROOT}/a/.git`]);
    await w.approve(plan);
    const e = await failure(w.apply(plan));
    expect(e.problems).toHaveLength(1);
    expect(e.problems[0]).toMatch(/^c0001 .*\.git: /);
    expect(w.fs.exists(`${ROOT}/a/.git`)).toBe(true);
  });

  it("a candidate that contains another candidate is refused", async () => {
    const nm = w.project("a");
    w.fs.writeFile(`${nm}/dep/node_modules/inner/f.js`);
    const plan = await w.plan([nm, `${nm}/dep/node_modules`]);
    await w.approve(plan);
    const e = await failure(w.apply(plan));
    expect(e.problems).toContain(`c0001 ${nm}: contains another candidate`);
  });

  it("a path that disappears between the chain check and the stat is reported as disappeared", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    let seen = 0;
    const fs = wrapFs(w.fs, { lstat: (p) => (p === nms[0] && ++seen === 2 ? Promise.reject(errno("ENOENT")) : w.fs.lstat(p)) });
    const e = await failure(w.apply(plan, { fs }));
    expect(e.problems).toEqual([`c0001 ${nms[0]}: path or its root disappeared`]);
  });

  it("an unreadable path chain is reported with the error code", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    const fs = wrapFs(w.fs, { lstat: (p) => (p === ROOT ? Promise.reject(errno("EACCES")) : w.fs.lstat(p)) });
    const e = await failure(w.apply(plan, { fs }));
    expect(e.problems).toEqual([`c0001 ${nms[0]}: cannot inspect the path (EACCES)`]);
  });

  it("a tree the walk refuses (a secret file name) is reported with the walk's reason", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.fs.writeFile(`${nms[0]}/dep/.env`);
    const e = await failure(w.apply(plan));
    expect(e.problems).toHaveLength(1);
    expect(e.problems[0]).toMatch(/^c0001 /);
    expect(e.problems[0]).not.toContain("contents changed");
  });

  it("never runs docker when file validation fails", async () => {
    const nm = w.project("a");
    const config = makeConfig({ dockerApply: true });
    const plan = await w.plan([nm], ["build-cache"], config);
    await w.approve(plan);
    w.fs.writeFile(`${nm}/dep/new.js`);
    await failure(w.apply(plan, {}, config));
    expect(w.docker.pruned).toEqual([]);
  });
});

describe("revalidate (the pure comparison wired to the ports)", () => {
  it("returns no problems when everything is as planned, and modifies nothing", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    const before = w.fs.renames.length;
    expect(await revalidate(w.ports(), w.config, plan, 1n)).toEqual([]);
    expect(w.fs.renames.length).toBe(before);
    for (const p of nms) expect(stateOf(p)).toBe("present");
  });

  it("returns the quarantine-device problem when the items device differs", async () => {
    const nm = w.project("a");
    const plan = await w.plan([nm]);
    expect(await revalidate(w.ports(), w.config, plan, 2n)).toEqual([
      `c0001 ${nm}: is on a different file system than the quarantine; rename cannot cross devices and copying is never done`,
    ]);
  });

  it("does not ask for open files when the plan has no file-system candidates", async () => {
    const plan = await w.plan([]);
    expect(await revalidate(w.ports(), w.config, plan, 1n)).toEqual([]);
    expect(w.openFiles.snapshots).toBe(0);
  });
});

describe("ApplyPlan: the move phase", () => {
  it("fires the hooks in order: afterValidate once before any rename, beforeRename per candidate", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    const log: string[] = [];
    w.hooks.afterValidate = () => void log.push(`validated renames=${w.fs.renames.length}`);
    w.hooks.beforeRename = (p) => void log.push(`before ${p} renames=${w.fs.renames.length}`);
    await w.apply(plan);
    expect(log).toEqual(["validated renames=0", `before ${nms[0]} renames=0`, `before ${nms[1]} renames=1`, `before ${nms[2]} renames=2`]);
  });

  it("the quick re-check catches a symlink swapped in after validation and rolls the earlier moves back", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.hooks.afterValidate = () => {
      w.fs.mkdir(`${ROOT}/victim`);
      w.fs.remove(nms[1] as string);
      w.fs.symlink(nms[1] as string, `${ROOT}/victim`);
    };
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("validation");
    expect(e.message).toBe(`aborted before moving ${nms[1]}: a symlink or non-directory appeared in the path`);
    expect(e.problems).toEqual([`c0002 ${nms[1]}: a symlink or non-directory appeared in the path`]);
    expect(stateOf(nms[0] as string)).toBe("present");
    expect(w.fs.exists(w.itemPath(plan, 1))).toBe(false);
    expect(await w.eventNames()).toEqual([
      "approval-consumed",
      "apply-start",
      "quarantine-begin",
      "quarantine-done",
      "apply-aborted",
      "rollback",
    ]);
    const events = await w.events();
    expect(events[4]?.data).toEqual({ planId: plan.id, path: nms[1], reason: "a symlink or non-directory appeared in the path" });
    expect(events[5]?.data).toEqual({ planId: plan.id, path: nms[0] });
    const m = await w.quarantine.load(plan.id);
    expect(m?.entries.map((x) => x.status)).toEqual(["restored", "pending", "pending"]);
    expect(m?.entries[0]?.restoredAt).toBe(w.clock.now());
    expect(w.lockState.holder).toBeNull();
  });

  it("the quick re-check catches a vanished candidate", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.hooks.afterValidate = () => void w.fs.remove(nms[0] as string);
    const e = await failure(w.apply(plan));
    expect(e.message).toBe(`aborted before moving ${nms[0]}: path disappeared`);
    expect(await w.eventNames()).toEqual(["approval-consumed", "apply-start", "apply-aborted"]);
  });

  it("the quick re-check catches a replaced directory (inode changed) and a candidate turned into a file", async () => {
    const nms = [w.project("a"), w.project("b")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.hooks.afterValidate = () => {
      w.fs.remove(nms[0] as string);
      w.fs.writeFile(`${nms[0]}/dep/index.js`);
    };
    expect((await failure(w.apply(plan))).message).toBe(`aborted before moving ${nms[0]}: device or inode changed`);

    const w2 = new DisposalWorld();
    const nm2 = [w2.project("a")];
    const plan2 = await w2.plan(nm2);
    await w2.approve(plan2);
    w2.hooks.afterValidate = () => {
      w2.fs.remove(nm2[0] as string);
      w2.fs.writeFile(nm2[0] as string);
    };
    expect((await failure(w2.apply(plan2))).message).toBe(`aborted before moving ${nm2[0]}: is no longer a real directory`);
  });

  it("a swap that wins the race after the re-check is detected after the rename, put back, and earlier moves rolled back", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.hooks.beforeRename = (p) => {
      if (p !== nms[1]) return;
      w.fs.remove(p);
      w.fs.mkdir(`${ROOT}/victim`);
      w.fs.symlink(p, `${ROOT}/victim`);
    };
    const e = await failure(w.apply(plan));
    expect(e.code).toBe("validation");
    expect(e.message).toBe(`aborted: ${nms[1]} changed between validation and rename; it was put back`);
    expect(await w.eventNames()).toEqual([
      "approval-consumed",
      "apply-start",
      "quarantine-begin",
      "quarantine-done",
      "quarantine-begin",
      "apply-aborted",
      "rollback",
    ]);
    const aborted = (await w.events()).find((x) => x.name === "apply-aborted");
    expect(aborted?.data).toEqual({ planId: plan.id, path: nms[1], reason: "item changed between validation and rename", undone: true });
    expect(stateOf(nms[0] as string)).toBe("present");
    expect((await w.fs.lstat(nms[1] as string)).isSymbolicLink()).toBe(true);
    expect(w.fs.exists(w.itemPath(plan, 2))).toBe(false);
  });

  it("when the swapped item cannot be put back it stays in quarantine and the error says so", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.hooks.beforeRename = (p) => {
      if (p !== nms[1]) return;
      w.fs.remove(p);
      w.fs.writeFile(`${p}/dep/other.js`);
    };
    const fs = wrapFs(w.fs, { rename: (a, b) => (b === nms[1] ? Promise.reject(errno("EIO")) : w.fs.rename(a, b)) });
    const e = await failure(w.apply(plan, { fs }));
    expect(e.message).toBe(`aborted: ${nms[1]} changed between validation and rename; it was NOT put back (see quarantine)`);
    const aborted = (await w.events()).find((x) => x.name === "apply-aborted");
    expect(aborted?.data).toMatchObject({ undone: false });
    expect(w.fs.exists(w.itemPath(plan, 2))).toBe(true);
  });

  it("an injected rename failure aborts, rolls every earlier move back newest first, and keeps the manifest truthful", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    const fs = wrapFs(w.fs, { rename: (a, b) => (a === nms[2] ? Promise.reject(errno("EXDEV")) : w.fs.rename(a, b)) });
    const e = await failure(w.apply(plan, { fs }));
    expect(e.code).toBe("io");
    expect(e.message).toBe(`aborted: could not move ${nms[2]} (EXDEV); earlier moves were rolled back`);
    expect(await w.eventNames()).toEqual([
      "approval-consumed",
      "apply-start",
      "quarantine-begin",
      "quarantine-done",
      "quarantine-begin",
      "quarantine-done",
      "quarantine-begin",
      "apply-aborted",
      "rollback",
      "rollback",
    ]);
    const events = await w.events();
    expect(events[7]?.data).toEqual({ planId: plan.id, path: nms[2], reason: "rename failed (EXDEV)" });
    expect(events.slice(8).map((x) => x.data["path"])).toEqual([nms[1], nms[0]]);
    for (const p of nms) expect(stateOf(p)).toBe("present");
    expect(w.fs.list(`${QUARANTINE_ROOT}/${plan.id}/items`)).toEqual([]);
    const m = await w.quarantine.load(plan.id);
    expect(m?.entries.map((x) => x.status)).toEqual(["restored", "restored", "pending"]);
  });

  it("a failing rollback is recorded as rollback-failed, the item stays in quarantine and the manifest says quarantined", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    const fs = wrapFs(w.fs, {
      rename: (a, b) => {
        if (a === nms[2]) return Promise.reject(errno("EIO"));
        if (b === nms[0]) return Promise.reject(errno("EBUSY"));
        return w.fs.rename(a, b);
      },
    });
    const e = await failure(w.apply(plan, { fs }));
    expect(e.code).toBe("io");
    expect((await w.eventNames()).slice(-3)).toEqual(["apply-aborted", "rollback", "rollback-failed"]);
    const events = await w.events();
    expect(events[events.length - 1]?.data).toEqual({ planId: plan.id, path: nms[0] });
    expect(stateOf(nms[0] as string)).toBe("absent");
    expect(w.fs.exists(w.itemPath(plan, 1))).toBe(true);
    expect(stateOf(nms[1] as string)).toBe("present");
    const m = await w.quarantine.load(plan.id);
    expect(m?.entries.map((x) => x.status)).toEqual(["quarantined", "restored", "pending"]);
  });

  it("a failure to save the manifest after the rollback does not mask the apply error", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    const fs = wrapFs(w.fs, { rename: (a, b) => (a === nms[1] ? Promise.reject(errno("EXDEV")) : w.fs.rename(a, b)) });
    const saves = w.quarantine.save.bind(w.quarantine);
    let n = 0;
    w.quarantine.save = async (m) => {
      if (++n === 3) throw errno("ENOSPC");
      return saves(m);
    };
    const e = await failure(w.apply(plan, { fs }));
    expect(e.code).toBe("io");
    expect(stateOf(nms[0] as string)).toBe("present");
  });

  it("an error from a test hook propagates unchanged and still releases the lock", async () => {
    const nms = three();
    const plan = await w.plan(nms);
    await w.approve(plan);
    const boom = new Error("hook failed");
    w.hooks.beforeRename = (p) => {
      if (p === nms[1]) throw boom;
    };
    await expect(w.apply(plan)).rejects.toBe(boom);
    expect(w.lockState.holder).toBeNull();
    expect(stateOf(nms[0] as string)).toBe("absent");
    expect(stateOf(nms[1] as string)).toBe("present");
  });

  it("a failure to write the first manifest propagates and leaves every candidate in place", async () => {
    const nms = [w.project("a")];
    const plan = await w.plan(nms);
    await w.approve(plan);
    w.quarantine.failSave = "EACCES";
    await expect(w.apply(plan)).rejects.toMatchObject({ code: "EACCES" });
    expect(stateOf(nms[0] as string)).toBe("present");
    expect(w.lockState.holder).toBeNull();
  });
});

describe("ApplyPlan: docker candidates", () => {
  const dockerConfig = () => makeConfig({ dockerApply: true });

  it("prunes after the file moves, in plan order, and publishes begin/done per resource", async () => {
    const nm = w.project("a");
    const config = dockerConfig();
    const plan = await w.plan([nm], ["build-cache", "dangling-images"], config);
    await w.approve(plan);
    w.docker.pruneResult = { ok: true, detail: "Total reclaimed space: 1GB" };
    const result = await w.apply(plan, {}, config);
    expect(w.docker.pruned).toEqual(["build-cache", "dangling-images"]);
    expect(result.docker).toEqual([
      { id: "c0002", resource: "build-cache", ok: true, detail: "Total reclaimed space: 1GB" },
      { id: "c0003", resource: "dangling-images", ok: true, detail: "Total reclaimed space: 1GB" },
    ]);
    expect(await w.eventNames()).toEqual([
      "approval-consumed",
      "apply-start",
      "quarantine-begin",
      "quarantine-done",
      "docker-prune-begin",
      "docker-prune-done",
      "docker-prune-begin",
      "docker-prune-done",
      "apply-complete",
    ]);
    const events = await w.events();
    expect(events[4]?.data).toEqual({ planId: plan.id, resource: "build-cache" });
    expect(events[5]?.data).toEqual({ planId: plan.id, resource: "build-cache", ok: true, detail: "Total reclaimed space: 1GB" });
    expect(events[8]?.data).toEqual({ planId: plan.id, moved: 1, docker: 2 });
  });

  it("a failed prune is reported, does not stop the next one and does not throw", async () => {
    const config = dockerConfig();
    const plan = await w.plan([], ["build-cache", "dangling-images"], config);
    await w.approve(plan);
    let calls = 0;
    w.docker.prune = async (resource) => {
      w.docker.pruned.push(resource);
      return ++calls === 1 ? { ok: false, detail: "Cannot connect to the Docker daemon" } : { ok: true, detail: "done" };
    };
    const result = await w.apply(plan, {}, config);
    expect(result.docker.map((d) => [d.resource, d.ok, d.detail])).toEqual([
      ["build-cache", false, "Cannot connect to the Docker daemon"],
      ["dangling-images", true, "done"],
    ]);
    const done = (await w.events()).filter((x) => x.name === "docker-prune-done");
    expect(done.map((x) => x.data["ok"])).toEqual([false, true]);
    expect((await w.eventNames()).at(-1)).toBe("apply-complete");
  });

  it("a docker-only plan creates no quarantine directory and no manifest", async () => {
    const config = dockerConfig();
    const plan = await w.plan([], ["dangling-images"], config);
    await w.approve(plan);
    await w.apply(plan, {}, config);
    expect(w.fs.list(QUARANTINE_ROOT)).toEqual([]);
    expect(w.quarantine.texts.size).toBe(0);
    expect(await w.events()).toContainEqual({ name: "apply-start", data: { planId: plan.id, planDigest: plan.digest, fs: 0 } });
  });
});

describe("ApplyError", () => {
  it("carries its code and problems", () => {
    const e = new ApplyError("validation", "msg", ["a"]);
    expect([e.code, e.message, e.problems, e.name]).toEqual(["validation", "msg", ["a"], "ApplyError"]);
    expect(new ApplyError("io", "x").problems).toEqual([]);
  });

  it("the QuarantineError of the domain is a separate error type", () => {
    expect(new QuarantineError("x")).not.toBeInstanceOf(ApplyError);
  });
});
