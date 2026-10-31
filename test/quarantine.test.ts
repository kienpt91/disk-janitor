import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { nodeFs } from "../src/infrastructure/fs/node-fs.js";
import {
  itemsDir,
  listQuarantine,
  manifestPath,
  planQuarantineDir,
  previewRestore,
  purgeCandidates,
  purgeItems,
  purgeSetDigest,
  QuarantineError,
  readManifest,
  restore,
  writeManifest,
  type ManifestEntry,
  type PurgeItem,
} from "../src/quarantine.js";
import type { Deps } from "../src/composition/deps.js";
import type { State } from "../src/state.js";
import { approveAsHuman, DAY, makeSandbox, planFor, testDeps, treeHash, writeText, type Planned, type Sandbox } from "./helpers.js";
import { eventNames, makeThree, readEvents, runApply, storedItem } from "./helpers-apply.js";

interface World {
  projects: string[];
  nms: string[];
  T: number;
  deps: Deps;
  p: Planned;
  hashes: string[];
  state: State;
  planId: string;
  audit: AuditLog;
}

/** Three projects applied into quarantine at the fixed time T (injected clock). */
async function world(sb: Sandbox): Promise<World> {
  const T = Date.now();
  const t = makeThree(sb);
  const deps = testDeps({ now: () => T });
  const p = await planFor(sb, {}, deps);
  await approveAsHuman(p.state, p.plan, deps);
  const hashes = t.nms.map((nm) => treeHash(nm));
  await runApply(p);
  return { ...t, T, deps, p, hashes, state: p.state, planId: p.plan.id, audit: new AuditLog(p.state, deps.now) };
}


/** Re-sign a manifest after changing it (what a bug, not an attacker, could produce: the MAC key is needed). */
async function rewriteManifest(w: World, edit: (entries: ManifestEntry[]) => void): Promise<void> {
  const m = await readManifest(w.state, w.planId);
  if (!m) throw new Error("no manifest");
  const { mac: _mac, ...body } = m;
  const entries = structuredClone(body.entries);
  edit(entries);
  await writeManifest(w.state, { ...body, entries });
}

function setOriginal(entries: ManifestEntry[], path: string): void {
  const e = entries[0];
  if (!e) throw new Error("no entry");
  e.originalPath = path;
}

function purgeItemFor(planId: string, entry: PurgeItem["entry"]): PurgeItem {
  return { planId, entry, ageDays: 99 };
}

describe("quarantine: listing", () => {
  it("an untouched state directory lists nothing", async () => {
    const sb = makeSandbox();
    const p = await planFor(sb);
    expect(await listQuarantine(p.state)).toEqual({ manifests: [], problems: [] });
  });

  it("lists the manifest of an applied plan", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const l = await listQuarantine(w.state);
    expect(l.problems).toEqual([]);
    expect(l.manifests.map((m) => m.planId)).toEqual([w.planId]);
    expect(l.manifests[0]?.entries).toHaveLength(3);
    expect(l.manifests[0]?.createdAt).toBe(w.T);
    expect(l.manifests[0]?.entries.every((e) => e.quarantinedAt === w.T)).toBe(true);
  });

  it("reports a plan directory with a modified manifest as a problem and hides its entries", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const file = manifestPath(w.state, w.planId);
    writeFileSync(file, readFileSync(file, "utf8").replace("quarantined", "restored"));
    const l = await listQuarantine(w.state);
    expect(l.manifests).toEqual([]);
    expect(l.problems).toEqual([{ planId: w.planId, reason: "manifest signature is invalid: it was modified" }]);
  });

  it("reports directories without a manifest, symlinked plan directories, and ignores unrelated names", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const empty = "plan-20200101T000000Z-aaaaaaaa";
    const linked = "plan-20200101T000000Z-bbbbbbbb";
    mkdirSync(join(w.state.quarantineDir, empty));
    symlinkSync(sb.base, join(w.state.quarantineDir, linked));
    mkdirSync(join(w.state.quarantineDir, "not-a-plan"));
    const l = await listQuarantine(w.state);
    expect(l.manifests.map((m) => m.planId)).toEqual([w.planId]);
    expect(l.problems).toEqual([
      { planId: empty, reason: "no manifest" },
      { planId: linked, reason: "not a real directory" },
    ]);
  });

  it("rejects a manifest copied from another plan directory", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const other = "plan-20200101T000000Z-cccccccc";
    mkdirSync(join(w.state.quarantineDir, other));
    writeFileSync(join(w.state.quarantineDir, other, "manifest.json"), readFileSync(manifestPath(w.state, w.planId), "utf8"));
    await expect(readManifest(w.state, other)).rejects.toThrow("manifest belongs to a different plan");
  });

  it("refuses plan ids that are not plan ids (no path building from them)", async () => {
    const sb = makeSandbox();
    const p = await planFor(sb);
    expect(() => planQuarantineDir(p.state, "../../etc")).toThrow(QuarantineError);
    expect(() => itemsDir(p.state, "plan-1")).toThrow("invalid plan id");
    expect(await readManifest(p.state, "plan-20200101T000000Z-dddddddd")).toBeNull();
  });
});

describe("quarantine: restore", () => {
  it("round trip by plan id restores every item byte-identical and updates statuses and audit", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    for (const nm of w.nms) expect(existsSync(nm)).toBe(false);
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out.map((r) => r.ok)).toEqual([true, true, true]);
    expect(w.nms.map((nm) => treeHash(nm))).toEqual(w.hashes);
    expect(readdirSync(join(planQuarantineDir(w.state, w.planId), "items"))).toEqual([]);
    const m = await readManifest(w.state, w.planId);
    expect(m?.entries.map((e) => e.status)).toEqual(["restored", "restored", "restored"]);
    expect(m?.entries.every((e) => e.restoredAt === w.T)).toBe(true);
    const names = eventNames(await readEvents(w.state));
    expect(names.filter((n) => n === "restore-begin")).toHaveLength(3);
    expect(names.filter((n) => n === "restore-done")).toHaveLength(3);
    expect(names).not.toContain("restore-refused");
  });

  it("round trip by exact original path restores only that entry", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const out = await restore(w.state, w.deps, w.audit, w.nms[1] as string);
    expect(out).toHaveLength(1);
    expect(out[0]?.ok).toBe(true);
    expect(treeHash(w.nms[1] as string)).toBe(w.hashes[1]);
    expect(existsSync(w.nms[0] as string)).toBe(false);
    expect(existsSync(w.nms[2] as string)).toBe(false);
    const m = await readManifest(w.state, w.planId);
    expect(m?.entries.map((e) => e.status)).toEqual(["quarantined", "restored", "quarantined"]);
    const done = (await readEvents(w.state)).filter((e) => e.event === "restore-done");
    expect(done.map((e) => e.data["path"])).toEqual([w.nms[1]]);
  });

  it.each([
    ["a file", (path: string) => writeFileSync(path, "user data")],
    ["a directory", (path: string) => mkdirSync(join(path, "inner"), { recursive: true })],
    ["a symlink", (path: string) => symlinkSync("/nonexistent", path)],
  ])("refuses to overwrite %s that exists at the original path", async (_kind, plant) => {
    const sb = makeSandbox();
    const w = await world(sb);
    const target = w.nms[1] as string;
    plant(target);
    const planted = treeHash(target);
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out[1]?.reason).toBe("something already exists at the original path; refusing to overwrite");
    expect(treeHash(target)).toBe(planted);
    expect(treeHash(storedItem(w.state, w.p.plan, 1))).toBe(w.hashes[1]);
    const m = await readManifest(w.state, w.planId);
    expect(m?.entries.map((e) => e.status)).toEqual(["restored", "quarantined", "restored"]);
    const refused = (await readEvents(w.state)).filter((e) => e.event === "restore-refused");
    expect(refused.map((e) => e.data["path"])).toEqual([target]);
  });

  it("refuses when the parent directory is gone", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    rmSync(w.projects[2] as string, { recursive: true });
    const out = await restore(w.state, w.deps, w.audit, w.nms[2] as string);
    expect(out).toHaveLength(1);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.reason).toBe("parent directory does not exist");
    expect(existsSync(w.projects[2] as string)).toBe(false);
    expect(treeHash(storedItem(w.state, w.p.plan, 2))).toBe(w.hashes[2]);
  });

  it("refuses when the parent directory was replaced by a symlink", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const decoy = join(sb.base, "decoy");
    mkdirSync(decoy);
    renameSync(w.projects[2] as string, join(sb.base, "p3-aside"));
    symlinkSync(decoy, w.projects[2] as string);
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out.map((r) => r.ok)).toEqual([true, true, false]);
    expect(out[2]?.reason).toBe("a parent path component is a symlink or not a directory");
    expect(readdirSync(decoy)).toEqual([]);
  });

  it("refuses when the quarantined item was swapped for another directory (inode mismatch)", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const item = storedItem(w.state, w.p.plan, 0);
    renameSync(item, join(sb.base, "original-item"));
    writeText(join(item, "planted.txt"), "not what was quarantined\n");
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.reason).toBe("quarantined item changed (inode mismatch)");
    expect(existsSync(w.nms[0] as string)).toBe(false);
    expect(out.map((r) => r.ok)).toEqual([false, true, true]);
  });

  it("refuses when the quarantined item became a symlink or went missing", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const victim = join(sb.base, "victim");
    writeText(join(victim, "data.txt"), "precious\n");
    const victimHash = treeHash(victim);
    const first = storedItem(w.state, w.p.plan, 0);
    rmSync(first, { recursive: true });
    symlinkSync(victim, first);
    rmSync(storedItem(w.state, w.p.plan, 1), { recursive: true });
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out.map((r) => r.reason)).toEqual(["quarantined item is not a directory any more", "quarantined item is missing", undefined]);
    expect(treeHash(victim)).toBe(victimHash);
    expect(existsSync(w.nms[0] as string)).toBe(false);
  });

  it("refuses an entry whose original path lies outside the roots recorded in the manifest", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const elsewhere = join(sb.base, "elsewhere");
    mkdirSync(elsewhere);
    await rewriteManifest(w, (entries) => {
      setOriginal(entries, join(elsewhere, "node_modules"));
    });
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out[0]?.reason).toBe("original path is outside the roots recorded in the manifest");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(out.map((r) => r.ok)).toEqual([false, true, true]);
  });

  it("refuses an entry whose original path is protected even inside a root", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const ssh = join(sb.projects, ".ssh");
    mkdirSync(ssh);
    await rewriteManifest(w, (entries) => {
      setOriginal(entries, join(ssh, "node_modules"));
    });
    const out = await restore(w.state, w.deps, w.audit, w.planId);
    expect(out[0]?.reason).toBe('path component ".ssh" is protected');
    expect(readdirSync(ssh)).toEqual([]);
  });

  it("a manifest edited without the key is rejected and nothing is restored", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const file = manifestPath(w.state, w.planId);
    writeFileSync(file, readFileSync(file, "utf8").replace(w.nms[0] as string, join(sb.base, "evil", "node_modules")));
    await expect(readManifest(w.state, w.planId)).rejects.toThrow(QuarantineError);
    await expect(readManifest(w.state, w.planId)).rejects.toThrow(/signature is invalid/);
    expect(await restore(w.state, w.deps, w.audit, w.planId)).toEqual([]);
    expect(await restore(w.state, w.deps, w.audit, w.nms[0] as string)).toEqual([]);
    for (const nm of w.nms) expect(existsSync(nm)).toBe(false);
    expect(existsSync(join(sb.base, "evil"))).toBe(false);
  });

  it("a manifest with a missing key cannot be authenticated", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    rmSync(w.state.keyPath);
    await expect(readManifest(w.state, w.planId)).rejects.toThrow("approval key missing: cannot authenticate manifest");
  });

  it("previewRestore predicts exactly what restore does", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    mkdirSync(w.nms[1] as string);
    rmSync(w.projects[2] as string, { recursive: true });
    const preview = await previewRestore(w.state, w.deps, w.planId);
    expect(preview.map((r) => r.ok)).toEqual([true, false, false]);
    expect(existsSync(w.nms[0] as string)).toBe(false);
    const real = await restore(w.state, w.deps, w.audit, w.planId);
    expect(real.map((r) => [r.entry.stored, r.ok, r.reason])).toEqual(preview.map((r) => [r.entry.stored, r.ok, r.reason]));
    expect(preview[1]?.reason).toContain("refusing to overwrite");
    expect(preview[2]?.reason).toBe("parent directory does not exist");
  });

  it("previewRestore changes nothing on disk or in the audit log", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const auditBefore = readFileSync(w.state.auditPath, "utf8");
    const manifestBefore = readFileSync(manifestPath(w.state, w.planId), "utf8");
    const preview = await previewRestore(w.state, w.deps, w.planId);
    expect(preview.every((r) => r.ok)).toBe(true);
    expect(readFileSync(w.state.auditPath, "utf8")).toBe(auditBefore);
    expect(readFileSync(manifestPath(w.state, w.planId), "utf8")).toBe(manifestBefore);
    for (const nm of w.nms) expect(existsSync(nm)).toBe(false);
  });

  it("restoring an already restored entry does nothing", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    await restore(w.state, w.deps, w.audit, w.planId);
    const auditBefore = readFileSync(w.state.auditPath, "utf8");
    expect(await restore(w.state, w.deps, w.audit, w.planId)).toEqual([]);
    expect(await restore(w.state, w.deps, w.audit, w.nms[0] as string)).toEqual([]);
    expect(await previewRestore(w.state, w.deps, w.planId)).toEqual([]);
    expect(readFileSync(w.state.auditPath, "utf8")).toBe(auditBefore);
    expect(w.nms.map((nm) => treeHash(nm))).toEqual(w.hashes);
  });

  it("an unknown selector matches nothing", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    expect(await restore(w.state, w.deps, w.audit, "plan-20200101T000000Z-eeeeeeee")).toEqual([]);
    expect(await restore(w.state, w.deps, w.audit, join(sb.projects, "nope", "node_modules"))).toEqual([]);
    expect(await restore(w.state, w.deps, w.audit, "../../etc")).toEqual([]);
  });

  it("a rename failure during restore is reported, audited and leaves the item in quarantine", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const failing = { ...w.deps, fs: { ...nodeFs, rename: () => Promise.reject(Object.assign(new Error("x"), { code: "EXDEV" })) } };
    const out = await restore(w.state, failing, w.audit, w.nms[0] as string);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.reason).toBe("rename failed (EXDEV)");
    expect(treeHash(storedItem(w.state, w.p.plan, 0))).toBe(w.hashes[0]);
    expect((await readManifest(w.state, w.planId))?.entries[0]?.status).toBe("quarantined");
    const failed = (await readEvents(w.state)).filter((e) => e.event === "restore-failed");
    expect(failed.map((e) => e.data["reason"])).toEqual(["EXDEV"]);
    // a later restore with the real file system succeeds
    expect((await restore(w.state, w.deps, w.audit, w.nms[0] as string))[0]?.ok).toBe(true);
  });

  it("restore leaves the audit chain valid", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    mkdirSync(w.nms[0] as string);
    await restore(w.state, w.deps, w.audit, w.planId);
    const v = await w.audit.verify();
    expect(v.ok).toBe(true);
  });
});

describe("quarantine: purge", () => {
  it("honours the TTL with an injected clock (6d23h59m59.999s no, 7d yes)", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const ttl = 7 * DAY;
    expect((await purgeCandidates(w.state, ttl, w.T + ttl - 1)).items).toEqual([]);
    const eligible = await purgeCandidates(w.state, ttl, w.T + ttl);
    expect(eligible.items.map((i) => [i.planId, i.entry.stored, i.ageDays])).toEqual([
      [w.planId, "0001", 7],
      [w.planId, "0002", 7],
      [w.planId, "0003", 7],
    ]);
    expect(eligible.problems).toEqual([]);
  });

  it("a TTL of 0 makes everything eligible immediately", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const r = await purgeCandidates(w.state, 0, w.T);
    expect(r.items).toHaveLength(3);
    expect(r.items.every((i) => i.ageDays === 0)).toBe(true);
  });

  it("only entries with status quarantined are candidates", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    await restore(w.state, w.deps, w.audit, w.nms[0] as string);
    let r = await purgeCandidates(w.state, 0, w.T);
    expect(r.items.map((i) => i.entry.stored)).toEqual(["0002", "0003"]);
    await purgeItems(w.state, w.deps, w.audit, [r.items[0] as PurgeItem]);
    r = await purgeCandidates(w.state, 0, w.T);
    expect(r.items.map((i) => i.entry.stored)).toEqual(["0003"]);
  });

  it("purgeItems deletes only the item directory named by the manifest", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const base = planQuarantineDir(w.state, w.planId);
    writeText(join(base, "decoy.txt"), "decoy file next to items\n");
    writeText(join(base, "foreign", "keep.txt"), "foreign dir inside the plan quarantine\n");
    writeText(join(base, "items", "9999", "stray.txt"), "unlisted stored name\n");
    const decoyHash = treeHash(join(base, "foreign"));
    const { items } = await purgeCandidates(w.state, 0, w.T);
    const res = await purgeItems(w.state, w.deps, w.audit, [items[0] as PurgeItem]);
    expect(res.failed).toEqual([]);
    expect(res.purged).toHaveLength(1);
    expect(existsSync(join(base, "items", "0001"))).toBe(false);
    expect(existsSync(join(base, "items", "0002"))).toBe(true);
    expect(existsSync(join(base, "items", "0003"))).toBe(true);
    expect(readFileSync(join(base, "decoy.txt"), "utf8")).toBe("decoy file next to items\n");
    expect(treeHash(join(base, "foreign"))).toBe(decoyHash);
    expect(existsSync(join(base, "items", "9999", "stray.txt"))).toBe(true);
    expect(existsSync(manifestPath(w.state, w.planId))).toBe(true);
    // the restored-looking originals are not recreated and the other items are intact
    expect(treeHash(storedItem(w.state, w.p.plan, 1))).toBe(w.hashes[1]);
    expect(treeHash(storedItem(w.state, w.p.plan, 2))).toBe(w.hashes[2]);
  });

  it("marks the manifest entry purged with purgedAt and audits purge-begin and purge-done", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const later = { ...w.deps, now: () => w.T + 8 * DAY };
    const { items } = await purgeCandidates(w.state, 7 * DAY, later.now());
    expect(items).toHaveLength(3);
    const res = await purgeItems(w.state, later, new AuditLog(w.state, later.now), items);
    expect(res.purged.map((x) => x.entry.status)).toEqual(["purged", "purged", "purged"]);
    const m = await readManifest(w.state, w.planId);
    expect(m?.entries.map((e) => e.status)).toEqual(["purged", "purged", "purged"]);
    expect(m?.entries.every((e) => e.purgedAt === w.T + 8 * DAY)).toBe(true);
    expect(readdirSync(join(planQuarantineDir(w.state, w.planId), "items"))).toEqual([]);
    const events = await readEvents(w.state);
    const seq = events.filter((e) => e.event.startsWith("purge-")).map((e) => e.event);
    expect(seq).toEqual(["purge-begin", "purge-done", "purge-begin", "purge-done", "purge-begin", "purge-done"]);
    expect(events.find((e) => e.event === "purge-begin")?.data).toMatchObject({ planId: w.planId, stored: "0001", path: w.nms[0] });
    expect((await purgeCandidates(w.state, 0, later.now())).items).toEqual([]);
    // a purged entry cannot be restored
    expect(await restore(w.state, w.deps, w.audit, w.planId)).toEqual([]);
  });

  it("purging an entry that is not quarantined (already purged) fails without deleting anything", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const { items } = await purgeCandidates(w.state, 0, w.T);
    await purgeItems(w.state, w.deps, w.audit, [items[0] as PurgeItem]);
    const again = await purgeItems(w.state, w.deps, w.audit, [items[0] as PurgeItem]);
    expect(again.purged).toEqual([]);
    expect(again.failed).toEqual([{ item: items[0], reason: "not a quarantined entry of an authenticated manifest" }]);
    expect(existsSync(join(planQuarantineDir(w.state, w.planId), "items", "0002"))).toBe(true);
  });

  it("an item that was restored cannot be purged through a stale purge list", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const { items } = await purgeCandidates(w.state, 0, w.T);
    await restore(w.state, w.deps, w.audit, w.nms[0] as string);
    const res = await purgeItems(w.state, w.deps, w.audit, items);
    expect(res.failed.map((f) => f.item.entry.stored)).toEqual(["0001"]);
    expect(res.purged.map((x) => x.entry.stored)).toEqual(["0002", "0003"]);
    expect(treeHash(w.nms[0] as string)).toBe(w.hashes[0]);
  });

  it("a manifest whose stored name points outside items is rejected by the schema before any deletion", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const outside = join(w.state.quarantineDir, "x");
    writeText(join(outside, "keep.txt"), "must survive\n");
    const file = manifestPath(w.state, w.planId);
    writeFileSync(file, readFileSync(file, "utf8").replace('"0001"', '"../../x"'));
    const r = await purgeCandidates(w.state, 0, w.T);
    expect(r.items).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.planId).toBe(w.planId);
    const forged: PurgeItem = purgeItemFor(w.planId, { index: 1, stored: "0001", originalPath: w.nms[0] as string, detector: "node-modules", dev: "1", ino: "1", size: 1, mtimeMs: 1, status: "quarantined", quarantinedAt: 1 });
    await expect(purgeItems(w.state, w.deps, w.audit, [forged])).rejects.toThrow(QuarantineError);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("must survive\n");
    expect(treeHash(storedItem(w.state, w.p.plan, 1))).toBe(w.hashes[1]);
    expect(eventNames(await readEvents(w.state))).not.toContain("purge-begin");
  });

  it("a manifest with a changed size is rejected by its MAC before any deletion", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const file = manifestPath(w.state, w.planId);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/"size": (\d+)/, (_m, n: string) => `"size": ${Number(n) + 1}`));
    const r = await purgeCandidates(w.state, 0, w.T);
    expect(r.items).toEqual([]);
    expect(r.problems[0]?.reason).toContain("signature is invalid");
    const forged = purgeItemFor(w.planId, { index: 1, stored: "0001", originalPath: w.nms[0] as string, detector: "node-modules", dev: "1", ino: "1", size: 1, mtimeMs: 1, status: "quarantined", quarantinedAt: 1 });
    await expect(purgeItems(w.state, w.deps, w.audit, [forged])).rejects.toThrow(/signature is invalid/);
    for (let i = 0; i < 3; i++) expect(treeHash(storedItem(w.state, w.p.plan, i))).toBe(w.hashes[i]);
  });

  it("a quarantined item replaced by a symlink to a victim: purge removes the symlink only", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const victim = join(sb.base, "victim");
    writeText(join(victim, "data.txt"), "precious\n");
    writeText(join(victim, "deep", "more.txt"), "precious too\n");
    const victimHash = treeHash(victim);
    const item = storedItem(w.state, w.p.plan, 0);
    rmSync(item, { recursive: true });
    symlinkSync(victim, item);
    const { items } = await purgeCandidates(w.state, 0, w.T);
    const res = await purgeItems(w.state, w.deps, w.audit, [items[0] as PurgeItem]);
    expect(res.purged).toHaveLength(1);
    expect(() => lstatSync(item)).toThrow();
    expect(treeHash(victim)).toBe(victimHash);
  });

  it("an items directory replaced by a symlink is refused: the victim survives", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const victim = join(sb.base, "victim");
    for (const n of ["0001", "0002", "0003"]) writeText(join(victim, n, "data.txt"), "precious\n");
    const victimHash = treeHash(victim);
    const items = join(planQuarantineDir(w.state, w.planId), "items");
    const { items: list } = await purgeCandidates(w.state, 0, w.T);
    renameSync(items, join(sb.base, "items-aside"));
    symlinkSync(victim, items);
    const res = await purgeItems(w.state, w.deps, w.audit, list);
    expect(res.purged).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual(Array(3).fill("items directory is not where the manifest says"));
    expect(treeHash(victim)).toBe(victimHash);
    expect(eventNames(await readEvents(w.state))).not.toContain("purge-begin");
  });

  it("purgeSetDigest is stable for a set, order independent and changes when the set changes", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const { items } = await purgeCandidates(w.state, 0, w.T);
    const [a, b, c] = items as [PurgeItem, PurgeItem, PurgeItem];
    const full = purgeSetDigest([a, b, c]);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    expect(purgeSetDigest([c, a, b])).toBe(full);
    expect(purgeSetDigest([a, b])).not.toBe(full);
    expect(purgeSetDigest([a, b, { ...c, planId: "plan-20200101T000000Z-ffffffff" }])).not.toBe(full);
    expect(purgeSetDigest([])).not.toBe(full);
    // the digest only depends on plan id and stored name, not on ages
    expect(purgeSetDigest([{ ...a, ageDays: 400 }, b, c])).toBe(full);
  });

  it("purging items of one plan leaves another plan's quarantine untouched", async () => {
    const sb = makeSandbox();
    const w = await world(sb);
    const other = "plan-20200101T000000Z-99999999";
    mkdirSync(join(w.state.quarantineDir, other, "items", "0001"), { recursive: true });
    writeText(join(w.state.quarantineDir, other, "items", "0001", "x.txt"), "other plan\n");
    const { items } = await purgeCandidates(w.state, 0, w.T);
    const res = await purgeItems(w.state, w.deps, w.audit, items);
    expect(res.purged).toHaveLength(3);
    expect(readFileSync(join(w.state.quarantineDir, other, "items", "0001", "x.txt"), "utf8")).toBe("other plan\n");
  });
});
