import { cpSync, existsSync, lstatSync, linkSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { applyPlan } from "../src/apply.js";
import { AuditLog } from "../src/audit.js";
import type { Deps } from "../src/deps.js";
import { nodeFs } from "../src/infrastructure/fs/node-fs.js";
import { computePlanDigest } from "../src/plan.js";
import { readManifest, restore } from "../src/quarantine.js";
import type { FsCandidate } from "../src/domain/model/types.js";
import { ageTree, approveAsHuman, makeProject, makeSandbox, planFor, testDeps, treeHash, writeText, type Planned, type Sandbox } from "./helpers.js";
import { catchApply, eventNames, fsCandidates, hashExcluding, makeThree, readEvents, retarget, runApply, setPath, storedItem, withDev } from "./helpers-apply.js";

/** Three planned and approved projects plus a victim directory outside every root. */
async function armed(sb: Sandbox) {
  const t = makeThree(sb);
  const victim = join(sb.base, "victim");
  writeText(join(victim, "data.txt"), "precious\n");
  writeText(join(victim, "nested", "more.txt"), "also precious\n");
  const p = await planFor(sb);
  expect(fsCandidates(p.plan).map((c) => c.path)).toEqual(t.nms);
  await approveAsHuman(p.state, p.plan, p.deps);
  return { ...t, victim, victimHash: treeHash(victim), p, last: t.nms[2] as string, lastProject: t.projects[2] as string };
}

/** Everything is as before the failed apply and no quarantine remains. */
function expectUntouched(sb: Sandbox, p: Planned, before: string): void {
  expect(treeHash(sb.projects)).toBe(before);
  expect(existsSync(join(p.state.quarantineDir, p.plan.id))).toBe(false);
}

describe("attacks: symlinks planted after planning", () => {
  it("(a) candidate replaced by a symlink to a victim directory", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    rmSync(s.last, { recursive: true });
    symlinkSync(s.victim, s.last);
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toContain(s.last);
    expect(err.problems[0]).toContain("symlink");
    expectUntouched(sb, s.p, before);
    expect(treeHash(s.victim)).toBe(s.victimHash);
    expect(readlinkSync(s.last)).toBe(s.victim);
    expect(eventNames(await readEvents(s.p.state))).toContain("apply-aborted");
  });

  it("(b) candidate parent (project dir) replaced by a symlink to a directory with an identical node_modules", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const aside = join(sb.base, "p3-moved");
    const decoy = join(sb.base, "decoy");
    writeText(join(decoy, "node_modules", "dep", "index.js"), "decoy content\n");
    renameSync(s.lastProject, aside);
    symlinkSync(decoy, s.lastProject);
    const decoyHash = treeHash(decoy);
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([expect.stringContaining(s.last)]);
    expect(err.problems[0]).toContain("symlink");
    expectUntouched(sb, s.p, before);
    expect(treeHash(decoy)).toBe(decoyHash);
    expect(existsSync(join(aside, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("(c) a symlink introduced in an ancestor between the root and the project", async () => {
    const sb = makeSandbox();
    const group = join(sb.projects, "group");
    makeProject(join(group, "p4"), { nodeModules: 4096 });
    const t = makeThree(sb);
    const p = await planFor(sb);
    const nested = join(group, "p4", "node_modules");
    expect(fsCandidates(p.plan).map((c) => c.path)).toContain(nested);
    await approveAsHuman(p.state, p.plan, p.deps);
    const decoy = join(sb.base, "decoy-group");
    writeText(join(decoy, "p4", "node_modules", "dep", "index.js"), "decoy\n");
    renameSync(group, join(sb.base, "group-moved"));
    symlinkSync(decoy, group);
    const decoyHash = treeHash(decoy);
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(p));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toContain(nested);
    expectUntouched(sb, p, before);
    expect(treeHash(decoy)).toBe(decoyHash);
    for (const nm of t.nms) expect(existsSync(nm)).toBe(true);
  });

  it("(d) symlinks inside node_modules travel with the rename and are never followed (apply and restore)", async () => {
    const sb = makeSandbox();
    const victim = join(sb.base, "victim");
    writeText(join(victim, "data.txt"), "precious\n");
    const proj = makeProject(join(sb.projects, "app"), { nodeModules: 9000 });
    const nm = join(proj, "node_modules");
    symlinkSync(victim, join(nm, "dep", "to-victim"));
    symlinkSync(join(victim, "data.txt"), join(nm, "dep", "to-victim-file"));
    symlinkSync("/nonexistent/dangling-target", join(nm, "dep", "dangling"));
    symlinkSync("../../..", join(nm, "dep", "escape-up"));
    ageTree(proj, 60);
    const victimHash = treeHash(victim);
    const before = treeHash(nm);
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path)).toEqual([nm]);
    await approveAsHuman(p.state, p.plan, p.deps);
    const res = await runApply(p);
    expect(res.moved).toHaveLength(1);
    expect(treeHash(victim)).toBe(victimHash);
    const item = storedItem(p.state, p.plan, 0);
    expect(lstatSync(join(item, "dep", "to-victim")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(item, "dep", "to-victim"))).toBe(victim);
    expect(readlinkSync(join(item, "dep", "dangling"))).toBe("/nonexistent/dangling-target");
    expect(treeHash(item)).toBe(before);
    const out = await restore(p.state, p.deps, new AuditLog(p.state, p.deps.now), p.plan.id);
    expect(out.map((r) => r.ok)).toEqual([true]);
    expect(treeHash(nm)).toBe(before);
    expect(treeHash(victim)).toBe(victimHash);
    expect(readlinkSync(join(nm, "dep", "escape-up"))).toBe("../../..");
  });

  it("(e) candidate replaced by a different directory with the same name (new inode)", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const aside = join(sb.base, "nm-aside");
    renameSync(s.last, aside);
    cpSync(aside, s.last, { recursive: true });
    const before = treeHash(sb.projects);
    const asideHash = treeHash(aside);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([expect.stringContaining("device or inode changed")]);
    expect(err.problems[0]).toContain(s.last);
    expectUntouched(sb, s.p, before);
    expect(treeHash(aside)).toBe(asideHash);
  });

  it("(f) the root itself replaced by a symlink: every candidate is refused", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const moved = join(sb.base, "projects-moved");
    renameSync(sb.projects, moved);
    symlinkSync(moved, sb.projects);
    const movedHash = treeHash(moved);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(3);
    for (const [i, nm] of s.nms.entries()) {
      expect(err.problems[i]).toContain(nm);
      expect(err.problems[i]).toContain("symlink");
    }
    expect(treeHash(moved)).toBe(movedHash);
    expect(lstatSync(sb.projects).isSymbolicLink()).toBe(true);
    expect(existsSync(join(s.p.state.quarantineDir, s.p.plan.id))).toBe(false);
  });

  it("a candidate replaced by a symlink to another candidate does not move that candidate twice", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    rmSync(s.last, { recursive: true });
    symlinkSync(s.nms[0] as string, s.last);
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expectUntouched(sb, s.p, before);
    expect(existsSync(join(s.nms[0] as string, "dep", "index.js"))).toBe(true);
  });
});

describe("attacks: races injected between validation and rename", () => {
  it("candidate swapped for a symlink to a victim right before its rename: nothing is silently quarantined", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const aside = join(sb.base, "nm-aside");
    const hashes = s.nms.slice(0, 2).map((nm) => treeHash(nm));
    const asideSource = treeHash(s.last);
    const deps: Deps = {
      ...s.p.deps,
      hooks: {
        beforeRename(path) {
          if (path !== s.last) return;
          renameSync(s.last, aside);
          symlinkSync(s.victim, s.last);
        },
      },
    };
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("changed between validation and rename");
    expect(err.message).toContain("put back");
    // the victim is untouched and the swapped-in symlink is back where the attacker put it
    expect(treeHash(s.victim)).toBe(s.victimHash);
    expect(lstatSync(s.last).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.last)).toBe(s.victim);
    expect(treeHash(aside)).toBe(asideSource);
    // earlier moves were rolled back
    expect([s.nms[0], s.nms[1]].map((nm) => treeHash(nm as string))).toEqual(hashes);
    const items = join(s.p.state.quarantineDir, s.p.plan.id, "items");
    expect(readdirSync(items)).toEqual([]);
    const m = await readManifest(s.p.state, s.p.plan.id);
    expect(m?.entries.map((e) => e.status)).toEqual(["restored", "restored", "pending"]);
    const events = await readEvents(s.p.state);
    const aborted = events.find((e) => e.event === "apply-aborted");
    expect(aborted?.data).toMatchObject({ path: s.last, reason: "item changed between validation and rename", undone: true });
    expect(events.filter((e) => e.event === "rollback").map((e) => e.data["path"])).toEqual([s.nms[1], s.nms[0]]);
    expect(eventNames(events)).not.toContain("apply-complete");
  });

  it("parent swapped for a symlink to a directory with a same-named node_modules: the other directory is put back", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const decoy = join(sb.base, "decoy");
    writeText(join(decoy, "node_modules", "dep", "index.js"), "decoy content\n");
    const decoyHash = treeHash(decoy);
    const aside = join(sb.base, "p3-aside");
    const asideHash = treeHash(s.lastProject);
    const deps: Deps = {
      ...s.p.deps,
      hooks: {
        beforeRename(path) {
          if (path !== s.last) return;
          renameSync(s.lastProject, aside);
          symlinkSync(decoy, s.lastProject);
        },
      },
    };
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("put back");
    expect(treeHash(decoy)).toBe(decoyHash);
    expect(existsSync(join(decoy, "node_modules", "dep", "index.js"))).toBe(true);
    expect(treeHash(aside)).toBe(asideHash);
    expect(existsSync(join(s.p.state.quarantineDir, s.p.plan.id, "items", "0003"))).toBe(false);
    expect(treeHash(s.victim)).toBe(s.victimHash);
    for (const nm of s.nms.slice(0, 2)) expect(existsSync(join(nm, "dep", "index.js"))).toBe(true);
    const aborted = (await readEvents(s.p.state)).find((e) => e.event === "apply-aborted");
    expect(aborted?.data["undone"]).toBe(true);
  });

  it("content changed after validation but before the rename: only identity is rechecked, the new file travels along", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const first = s.nms[0] as string;
    const deps: Deps = {
      ...s.p.deps,
      hooks: {
        afterValidate() {
          writeFileSync(join(first, "dep", "late.js"), "added after validation\n");
        },
      },
    };
    // Observed behavior: a content change inside the candidate (same directory inode) passes the
    // post-rename identity check, so the apply succeeds and quarantines the new file as well.
    const res = await runApply(s.p, deps);
    expect(res.moved.map((m) => m.path)).toEqual(s.nms);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(join(storedItem(s.p.state, s.p.plan, 0), "dep", "late.js"))).toBe(true);
    const out = await restore(s.p.state, deps, new AuditLog(s.p.state, deps.now), s.p.plan.id);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(existsSync(join(first, "dep", "late.js"))).toBe(true);
  });

  it("afterValidate that swaps a candidate for a different directory is caught by the quick recheck", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const aside = join(sb.base, "nm-aside");
    const deps: Deps = {
      ...s.p.deps,
      hooks: {
        afterValidate() {
          renameSync(s.last, aside);
          cpSync(aside, s.last, { recursive: true });
        },
      },
    };
    const hashes = s.nms.slice(0, 2).map((nm) => treeHash(nm));
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("validation");
    expect(err.message).toContain("aborted before moving");
    expect(err.problems).toEqual([expect.stringContaining("device or inode changed")]);
    expect([s.nms[0], s.nms[1]].map((nm) => treeHash(nm as string))).toEqual(hashes);
    const m = await readManifest(s.p.state, s.p.plan.id);
    expect(m?.entries.map((e) => e.status)).toEqual(["restored", "restored", "pending"]);
  });

  it.each([
    ["EXDEV", 1],
    ["EPERM", 2],
    ["EACCES", 0],
  ])("rename failure %s on candidate index %i rolls back earlier moves and reports an io error", async (code, failAt) => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const failing = s.nms[failAt] as string;
    const originals = s.nms.map((nm) => treeHash(nm));
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async rename(from, to) {
          if (from === failing) throw Object.assign(new Error(`injected ${code}`), { code });
          return nodeFs.rename(from, to);
        },
      },
    };
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("io");
    expect(err.message).toContain(code);
    expect(err.message).toContain("earlier moves were rolled back");
    expect(s.nms.map((nm) => treeHash(nm))).toEqual(originals);
    const m = await readManifest(s.p.state, s.p.plan.id);
    expect(m?.entries.map((e) => e.status)).toEqual(s.nms.map((_nm, i) => (i < failAt ? "restored" : "pending")));
    for (const e of m?.entries.slice(0, failAt) ?? []) expect(e.restoredAt).toBeDefined();
    expect(readdirSync(join(s.p.state.quarantineDir, s.p.plan.id, "items"))).toEqual([]);
    const events = await readEvents(s.p.state);
    expect(events.filter((e) => e.event === "rollback")).toHaveLength(failAt);
    expect(events.find((e) => e.event === "apply-aborted")?.data["reason"]).toBe(`rename failed (${code})`);
    expect(eventNames(events)).not.toContain("apply-complete");
  });

  it("a failed rollback is reported in the audit log and the stuck item stays in quarantine", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const failing = s.nms[1] as string;
    const first = storedItem(s.p.state, s.p.plan, 0);
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async rename(from, to) {
          if (from === failing) throw Object.assign(new Error("injected"), { code: "EXDEV" });
          if (from === first) throw Object.assign(new Error("rollback blocked"), { code: "EBUSY" });
          return nodeFs.rename(from, to);
        },
      },
    };
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("io");
    const events = await readEvents(s.p.state);
    expect(events.filter((e) => e.event === "rollback-failed").map((e) => e.data["path"])).toEqual([s.nms[0]]);
    // the item is still safe in quarantine and recorded as quarantined, so it can be restored later
    expect(existsSync(first)).toBe(true);
    const m = await readManifest(s.p.state, s.p.plan.id);
    expect(m?.entries[0]?.status).toBe("quarantined");
    const out = await restore(s.p.state, s.p.deps, new AuditLog(s.p.state, s.p.deps.now), s.p.plan.id);
    expect(out.filter((r) => r.ok).map((r) => r.entry.originalPath)).toEqual([s.nms[0]]);
  });
});

describe("attacks: tampered plans (the approval does not whitelist bad paths)", () => {
  async function tamperedRun(sb: Sandbox, edit: (cands: FsCandidate[], nms: string[]) => void, keep = 3) {
    const t = makeThree(sb);
    const base = await planFor(sb);
    const edited = retarget(base.plan, (cands) => edit(cands, t.nms));
    const plan = { ...edited, candidates: edited.candidates.slice(0, keep) };
    plan.digest = computePlanDigest(plan);
    expect(plan.digest).toBe(computePlanDigest(plan));
    await approveAsHuman(base.state, plan, base.deps);
    const before = treeHash(sb.home);
    const err = await catchApply(applyPlan({ config: base.config, state: base.state, plan, deps: base.deps }));
    return { t, base, plan, err, before };
  }

  it("a path with .. segments that still resolves to a real candidate is refused as not canonical", async () => {
    const sb = makeSandbox();
    const { t, base, err, before } = await tamperedRun(sb, (c, nms) => {
      setPath(c, 0, `${nms[0]}/../node_modules`);
    });
    expect(err.code).toBe("validation");
    expect(err.problems.some((x) => x.includes("path is not canonical"))).toBe(true);
    expect(treeHash(sb.home)).toBe(before);
    for (const nm of t.nms) expect(existsSync(nm)).toBe(true);
    expect(existsSync(join(base.state.quarantineDir, base.plan.id))).toBe(false);
  });

  it("the literal /x/../etc is refused", async () => {
    const sb = makeSandbox();
    const { err, before } = await tamperedRun(sb, (c) => {
      setPath(c, 0, "/x/../etc");
    });
    expect(err.code).toBe("validation");
    expect(err.problems[0]).toContain("path is not canonical");
    expect(treeHash(sb.home)).toBe(before);
  });

  it("a real directory outside every root is refused", async () => {
    const sb = makeSandbox();
    const outside = join(sb.base, "outside", "node_modules");
    writeText(join(outside, "dep", "index.js"), "outside\n");
    const outsideHash = treeHash(outside);
    const { err, before } = await tamperedRun(sb, (c) => {
      setPath(c, 0, outside);
    });
    expect(err.code).toBe("validation");
    expect(err.problems[0]).toContain("outside the configured roots");
    expect(treeHash(outside)).toBe(outsideHash);
    expect(treeHash(sb.home)).toBe(before);
  });

  it("<home>/.ssh/x is refused", async () => {
    const sb = makeSandbox();
    const target = join(sb.home, ".ssh", "x");
    writeText(join(target, "id_demo"), "not a real key\n");
    const { err, before } = await tamperedRun(sb, (c) => {
      setPath(c, 0, target);
    });
    expect(err.code).toBe("validation");
    expect(err.problems[0]).toContain(target);
    expect(err.problems[0]).toContain("outside the configured roots");
    expect(existsSync(join(target, "id_demo"))).toBe(true);
    expect(treeHash(sb.home)).toBe(before);
  });

  it("a protected path inside a root (.config) is refused by the denylist", async () => {
    const sb = makeSandbox();
    const target = join(sb.projects, ".config", "app", "node_modules");
    writeText(join(target, "dep", "index.js"), "config data\n");
    const { err, before } = await tamperedRun(sb, (c) => {
      setPath(c, 0, target);
    });
    expect(err.code).toBe("validation");
    expect(err.problems[0]).toContain('path component ".config" is protected');
    expect(existsSync(join(target, "dep", "index.js"))).toBe(true);
    expect(treeHash(sb.home)).toBe(before);
  });

  it("a secret-looking directory inside a root is refused by the denylist", async () => {
    const sb = makeSandbox();
    const target = join(sb.projects, "my-secrets", "node_modules");
    writeText(join(target, "dep", "index.js"), "x\n");
    const { err, before } = await tamperedRun(sb, (c) => {
      setPath(c, 0, target);
    });
    expect(err.code).toBe("validation");
    expect(err.problems[0]).toContain("name looks like a secret");
    expect(treeHash(sb.home)).toBe(before);
  });

  it("the root itself and the home directory are refused as candidates", async () => {
    const sb = makeSandbox();
    const { err, before } = await tamperedRun(
      sb,
      (c) => {
        setPath(c, 0, sb.projects);
      },
      1,
    );
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([expect.stringContaining("device or inode changed")]);
    expect(treeHash(sb.home)).toBe(before);
    const sb2 = makeSandbox();
    const r2 = await tamperedRun(
      sb2,
      (c) => {
        setPath(c, 0, sb2.home);
      },
      1,
    );
    expect(r2.err.problems[0]).toContain("outside the configured roots");
  });

  it("overlapping candidates (parent and child) are refused", async () => {
    const sb = makeSandbox();
    const { t, err, before } = await tamperedRun(sb, (c, nms) => {
      // candidate 0 becomes the whole project directory, which contains candidate 1 (its node_modules)
      setPath(c, 0, (nms[0] as string).replace(/\/node_modules$/, ""));
      setPath(c, 1, nms[0] as string);
    });
    expect(err.code).toBe("validation");
    expect(err.problems.some((x) => x.includes("contains another candidate") && x.includes(t.projects[0] as string))).toBe(true);
    expect(treeHash(sb.home)).toBe(before);
  });

  it("duplicate candidate paths are refused", async () => {
    const sb = makeSandbox();
    const { err, before } = await tamperedRun(sb, (c, nms) => {
      setPath(c, 1, nms[0] as string);
    });
    expect(err.code).toBe("validation");
    expect(err.problems.filter((x) => x.includes("contains another candidate"))).toHaveLength(2);
    expect(treeHash(sb.home)).toBe(before);
  });

  it("an approval of the original plan does not cover a tampered plan with a recomputed digest", async () => {
    const sb = makeSandbox();
    const t = makeThree(sb);
    const p = await planFor(sb);
    await approveAsHuman(p.state, p.plan, p.deps);
    const evil = retarget(p.plan, (c) => {
      setPath(c, 0, join(sb.base, "elsewhere"));
    });
    expect(evil.digest).not.toBe(p.plan.digest);
    const err = await catchApply(applyPlan({ config: p.config, state: p.state, plan: evil, deps: p.deps }));
    expect(err.code).toBe("not-approved");
    for (const nm of t.nms) expect(existsSync(nm)).toBe(true);
  });

  it("directory names with encoded traversal or backslashes are just names", async () => {
    const sb = makeSandbox();
    const names = ["%2e%2e", "back\\slash", "..dots", "%2fslash"];
    const nms = names.map((n) => join(makeProject(join(sb.projects, n), { nodeModules: 5000 }), "node_modules"));
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path).sort()).toEqual([...nms].sort());
    await approveAsHuman(p.state, p.plan, p.deps);
    const res = await runApply(p);
    expect(res.moved.map((m) => m.path).sort()).toEqual([...nms].sort());
    for (const nm of nms) expect(existsSync(nm)).toBe(false);
    for (const n of names) expect(existsSync(join(sb.projects, n, "package.json"))).toBe(true);
    expect(readdirSync(sb.projects).sort()).toEqual([...names].sort());
  });
});

describe("attacks: devices, hard links, open files", () => {
  it("a root on a different device than the candidate is refused (injected lstat)", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async lstat(path) {
          const st = await nodeFs.lstat(path);
          return path === sb.projects ? withDev(st, st.dev + 1n) : st;
        },
      },
    };
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(3);
    for (const x of err.problems) expect(x).toContain("different file system than its root");
    expectUntouched(sb, s.p, before);
  });

  it("a quarantine items directory on a different device is refused: rename cannot cross devices", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const items = join(s.p.state.quarantineDir, s.p.plan.id, "items");
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async lstat(path) {
          const st = await nodeFs.lstat(path);
          return path === items ? withDev(st, st.dev + 7n) : st;
        },
      },
    };
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p, deps));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(3);
    for (const x of err.problems) expect(x).toContain("different file system than the quarantine");
    expectUntouched(sb, s.p, before);
    expect(eventNames(await readEvents(s.p.state))).toContain("apply-aborted");
  });

  it("a candidate whose device differs from the plan is refused", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async lstat(path) {
          const st = await nodeFs.lstat(path);
          return path === s.last ? withDev(st, st.dev + 1n) : st;
        },
      },
    };
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p, deps));
    expect(err.problems).toEqual([expect.stringContaining("device or inode changed")]);
    expectUntouched(sb, s.p, before);
  });

  it("a mount point inside the candidate (injected device change on a nested directory) is refused", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const nested = join(s.last, "dep");
    const deps: Deps = {
      ...s.p.deps,
      fs: {
        ...nodeFs,
        async lstat(path) {
          const st = await nodeFs.lstat(path);
          return path === nested ? withDev(st, st.dev + 1n) : st;
        },
      },
    };
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p, deps));
    expect(err.problems).toEqual([expect.stringContaining("crosses a file system boundary")]);
    expectUntouched(sb, s.p, before);
  });

  it("a candidate with a hard link outside is excluded from the plan", async () => {
    const sb = makeSandbox();
    const t = makeThree(sb);
    linkSync(join(t.nms[0] as string, "dep", "index.js"), join(t.projects[0] as string, "outside-link.js"));
    ageTree(t.projects[0] as string, 60);
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path)).toEqual([t.nms[1], t.nms[2]]);
  });

  it("a hard link created outside after planning aborts the apply", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    linkSync(join(s.last, "dep", "index.js"), join(s.lastProject, "late-link.js"));
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toContain(s.last);
    expect(err.problems[0]).toContain("hard links shared with files outside");
    expectUntouched(sb, s.p, before);
  });

  it("a file opened by a process after planning aborts the whole apply", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const open = testDeps({ lsof: [join(s.last, "dep", "index.js")] });
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p, open));
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([expect.stringContaining("a process has files open inside it")]);
    expect(err.problems[0]).toContain(s.last);
    expectUntouched(sb, s.p, before);
    expect(open.calls.some((c) => c.command === "lsof")).toBe(true);
  });

  it("a process whose working directory is the candidate also blocks the apply", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const open = testDeps({ lsof: [s.last] });
    const err = await catchApply(runApply(s.p, open));
    expect(err.problems).toEqual([expect.stringContaining("a process has files open inside it")]);
  });

  it("open files elsewhere do not block the apply", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const open = testDeps({ lsof: [join(s.lastProject, "src", "index.js"), join(sb.base, "victim", "data.txt")] });
    const res = await runApply(s.p, open);
    expect(res.moved).toHaveLength(3);
  });

  it("a special file (fifo) created inside after planning aborts", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const fifo = join(s.last, "dep", "pipe");
    execFileSync("mkfifo", [fifo]);
    const err = await catchApply(runApply(s.p));
    expect(err.code).toBe("validation");
    expect(err.problems).toEqual([expect.stringContaining("contains a device, socket or fifo")]);
    expect(err.problems[0]).toContain(s.last);
    // treeHash would block reading the fifo, so check by listing
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    for (const nm of s.nms) expect(existsSync(nm)).toBe(true);
    expect(existsSync(join(s.p.state.quarantineDir, s.p.plan.id))).toBe(false);
  });

  it("a new .env file planted inside a candidate after planning aborts the apply", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    // inside dep/, so the candidate directory's own mtime is unchanged and the name check is what fires
    writeFileSync(join(s.last, "dep", ".env"), "FAKE=1\n");
    const before = treeHash(sb.projects);
    const err = await catchApply(runApply(s.p));
    expect(err.problems).toEqual([expect.stringContaining("environment file")]);
    expectUntouched(sb, s.p, before);
  });

  it("nothing outside the candidates changes during a successful apply (exclusion hash)", async () => {
    const sb = makeSandbox();
    const s = await armed(sb);
    const exclude = new Set(s.nms);
    const before = hashExcluding(sb.home, exclude);
    await runApply(s.p);
    expect(hashExcluding(sb.home, exclude)).toBe(before);
    expect(treeHash(s.victim)).toBe(s.victimHash);
  });
});
