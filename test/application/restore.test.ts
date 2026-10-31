import { beforeEach, describe, expect, it } from "vitest";
import { findRestoreTargets, previewRestore, restore } from "../../src/application/restore.js";
import { listQuarantine, readManifest } from "../../src/application/quarantine-listing.js";
import type { Plan } from "../../src/domain/model/types.js";
import { Manifest, type ManifestBody } from "../../src/domain/quarantine/manifest.js";
import { DisposalWorld, errno, QUARANTINE_ROOT, ROOT, wrapFs } from "../support/disposal-world.js";

let w: DisposalWorld;
let nms: string[];
let plan: Plan;

beforeEach(async () => {
  w = new DisposalWorld();
  nms = [w.project("a", 12_000), w.project("b", 8_000), w.project("c", 4_000)];
  ({ plan } = await w.applied(nms));
});

async function rewrite(edit: (body: ManifestBody) => void, planId = plan.id): Promise<void> {
  const body = (await w.quarantine.load(planId))?.toBody() as ManifestBody;
  edit(body);
  await w.quarantine.save(Manifest.fromBody(body));
}

const present = (p: string) => w.fs.exists(p);
/** Event names after the apply (apply events are skipped). */
async function restoreEvents(): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
  return (await w.events()).filter((e) => e.name.startsWith("restore-"));
}

describe("restore by plan id", () => {
  it("puts every item back at its original path, byte-for-byte the same directory", async () => {
    const ino = await Promise.all([1, 2, 3].map(async (i) => (await w.fs.lstat(w.itemPath(plan, i))).ino));
    const results = await restore(w.disposalPorts(), plan.id);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    for (let i = 0; i < 3; i++) {
      expect((await w.fs.lstat(nms[i] as string)).ino).toBe(ino[i]);
      expect(present(w.itemPath(plan, i + 1))).toBe(false);
    }
  });

  it("publishes restore-begin and restore-done per entry, in order", async () => {
    await restore(w.disposalPorts(), plan.id);
    const events = await restoreEvents();
    expect(events.map((e) => e.name)).toEqual(["restore-begin", "restore-done", "restore-begin", "restore-done", "restore-begin", "restore-done"]);
    expect(events[0]?.data).toEqual({ planId: plan.id, path: nms[0] });
    expect(events[5]?.data).toEqual({ planId: plan.id, path: nms[2] });
  });

  it("marks the entries restored with restoredAt = now and keeps the seal valid", async () => {
    w.clock.advance(3_600_000);
    const results = await restore(w.disposalPorts(), plan.id);
    expect(results[0]?.entry).toMatchObject({ status: "restored", restoredAt: w.clock.now() });
    const m = await readManifest({ quarantine: w.quarantine }, plan.id);
    expect(m?.entries.map((e) => e.status)).toEqual(["restored", "restored", "restored"]);
  });

  it("restoring again does nothing: no targets, no events", async () => {
    await restore(w.disposalPorts(), plan.id);
    const before = (await w.events()).length;
    expect(await restore(w.disposalPorts(), plan.id)).toEqual([]);
    expect((await w.events()).length).toBe(before);
  });

  it("an unknown plan id or path matches nothing", async () => {
    expect(await restore(w.disposalPorts(), "plan-20200101T000000Z-ffffffff")).toEqual([]);
    expect(await restore(w.disposalPorts(), `${ROOT}/nothing/node_modules`)).toEqual([]);
    expect(await restoreEvents()).toEqual([]);
  });
});

describe("restore by original path", () => {
  it("restores only the entry whose original path is named", async () => {
    const results = await restore(w.disposalPorts(), nms[1] as string);
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.originalPath).toBe(nms[1]);
    expect(present(nms[1] as string)).toBe(true);
    expect(present(nms[0] as string)).toBe(false);
    expect(present(nms[2] as string)).toBe(false);
    expect((await readManifest({ quarantine: w.quarantine }, plan.id))?.entries.map((e) => e.status)).toEqual(["quarantined", "restored", "quarantined"]);
  });

  it("finds the entry in every plan that quarantined that path", async () => {
    await restore(w.disposalPorts(), nms[0] as string);
    w.fs.writeFile(`${nms[0]}/dep/index.js`);
    const second = await w.plan([nms[0] as string]);
    await w.approve(second);
    await w.apply(second);
    const targets = await findRestoreTargets(w.disposalPorts(), nms[0] as string);
    expect(targets.map((t) => t.manifest.planId)).toEqual([second.id]);
    expect(targets[0]?.entries.map((e) => e.status)).toEqual(["quarantined"]);
  });
});

describe("findRestoreTargets", () => {
  it("for a plan id lists its restorable entries; restored ones drop out", async () => {
    await restore(w.disposalPorts(), nms[0] as string);
    const [t] = await findRestoreTargets(w.disposalPorts(), plan.id);
    expect(t?.entries.map((e) => e.stored)).toEqual(["0002", "0003"]);
  });

  it("never offers a manifest that failed authentication", async () => {
    w.quarantine.texts.set(plan.id, (w.quarantine.texts.get(plan.id) as string).replace('"size"', '"size": 1, "x"'));
    expect(await findRestoreTargets(w.disposalPorts(), plan.id)).toEqual([]);
    expect(await restore(w.disposalPorts(), plan.id)).toEqual([]);
    expect(present(w.itemPath(plan, 1))).toBe(true);
  });
});

describe("previewRestore", () => {
  it("reports ok for every entry and changes nothing: no rename, no event, no manifest write", async () => {
    const text = w.quarantine.texts.get(plan.id);
    const events = (await w.events()).length;
    const checks = await previewRestore(w.disposalPorts(), plan.id);
    expect(checks.map((c) => [c.planId, c.ok, c.reason])).toEqual([[plan.id, true, undefined], [plan.id, true, undefined], [plan.id, true, undefined]]);
    expect(w.fs.renames).toHaveLength(3); // only the apply's own moves
    expect((await w.events()).length).toBe(events);
    expect(w.quarantine.texts.get(plan.id)).toBe(text);
  });
});

describe("restore refusals (each reason, via preview and via restore)", () => {
  const refusal = async (selector = nms[0] as string) => {
    const preview = await previewRestore(w.disposalPorts(), selector);
    const results = await restore(w.disposalPorts(), selector);
    expect(results.map((r) => r.reason)).toEqual(preview.map((p) => p.reason));
    return results[0]?.reason;
  };

  it("the quarantined item is missing", async () => {
    w.fs.remove(w.itemPath(plan, 1));
    expect(await refusal()).toBe("quarantined item is missing");
  });

  it("the quarantined item was replaced by a symlink or by a file", async () => {
    w.fs.remove(w.itemPath(plan, 1));
    w.fs.symlink(w.itemPath(plan, 1), "/somewhere");
    expect(await refusal()).toBe("quarantined item is not a directory any more");
  });

  it("the quarantined item is another directory (inode mismatch)", async () => {
    w.fs.remove(w.itemPath(plan, 1));
    w.fs.mkdir(w.itemPath(plan, 1));
    expect(await refusal()).toBe("quarantined item changed (inode mismatch)");
  });

  it("the original path lies outside the roots recorded in the manifest", async () => {
    await rewrite((b) => void ((b.entries[0] as { originalPath: string }).originalPath = "/elsewhere/node_modules"));
    expect(await refusal("/elsewhere/node_modules")).toBe("original path is outside the roots recorded in the manifest");
  });

  it("the original path is protected", async () => {
    await rewrite((b) => void ((b.entries[0] as { originalPath: string }).originalPath = `${ROOT}/a/.git`));
    const reason = await refusal(`${ROOT}/a/.git`);
    expect(reason).toBeTruthy();
    expect(reason).not.toBe("original path is outside the roots recorded in the manifest");
  });

  it("the parent directory no longer exists", async () => {
    w.fs.remove(`${ROOT}/a`);
    expect(await refusal()).toBe("parent directory does not exist");
  });

  it("a parent component became a symlink", async () => {
    w.fs.remove(`${ROOT}/a`);
    w.fs.symlink(`${ROOT}/a`, `${ROOT}/b`);
    expect(await refusal()).toBe("a parent path component is a symlink or not a directory");
  });

  it("something already exists at the original path: nothing is overwritten", async () => {
    w.fs.writeFile(nms[0] as string);
    expect(await refusal()).toBe("something already exists at the original path; refusing to overwrite");
    expect((await w.fs.lstat(nms[0] as string)).isFile()).toBe(true);
    expect(present(w.itemPath(plan, 1))).toBe(true);
  });

  it("the original path cannot be inspected", async () => {
    const fs = wrapFs(w.fs, { lstat: (p) => (p === nms[0] ? Promise.reject(errno("EACCES")) : w.fs.lstat(p)) });
    const ports = w.disposalPorts(fs);
    const results = await restore(ports, nms[0] as string);
    expect(results[0]?.reason).toBe("cannot inspect the original path");
    expect(present(w.itemPath(plan, 1))).toBe(true);
  });

  it("a refusal publishes restore-refused and does not stop the other entries", async () => {
    w.fs.writeFile(nms[0] as string);
    const results = await restore(w.disposalPorts(), plan.id);
    expect(results.map((r) => r.ok)).toEqual([false, true, true]);
    expect((await restoreEvents()).map((e) => e.name)).toEqual(["restore-refused", "restore-begin", "restore-done", "restore-begin", "restore-done"]);
    expect((await restoreEvents())[0]?.data).toEqual({ planId: plan.id, path: nms[0], reason: "something already exists at the original path; refusing to overwrite" });
    const m = await readManifest({ quarantine: w.quarantine }, plan.id);
    expect(m?.entries.map((e) => e.status)).toEqual(["quarantined", "restored", "restored"]);
  });

  it("a rename failure is reported as restore-failed with the code and leaves the item in quarantine", async () => {
    const fs = wrapFs(w.fs, { rename: (a, b) => (b === nms[1] ? Promise.reject(errno("EXDEV")) : w.fs.rename(a, b)) });
    const results = await restore(w.disposalPorts(fs), plan.id);
    expect(results.map((r) => r.reason)).toEqual([undefined, "rename failed (EXDEV)", undefined]);
    const failed = (await restoreEvents()).filter((e) => e.name === "restore-failed");
    expect(failed).toEqual([{ name: "restore-failed", data: { planId: plan.id, path: nms[1], reason: "EXDEV" } }]);
    expect(present(w.itemPath(plan, 2))).toBe(true);
    expect((await readManifest({ quarantine: w.quarantine }, plan.id))?.entries.map((e) => e.status)).toEqual(["restored", "quarantined", "restored"]);
  });
});

describe("restore of an interrupted apply (pending entries)", () => {
  it("restores the moved item; the pending one whose item never arrived is refused", async () => {
    const w2 = new DisposalWorld();
    const paths = [w2.project("a"), w2.project("b")];
    const p = await w2.plan(paths);
    await w2.approve(p);
    const boom = new Error("killed");
    w2.hooks.beforeRename = (path) => {
      if (path === paths[1]) throw boom;
    };
    await expect(w2.apply(p)).rejects.toBe(boom);
    const m = await w2.quarantine.load(p.id);
    expect(m?.entries.map((e) => e.status)).toEqual(["quarantined", "pending"]);
    const results = await restore(w2.disposalPorts(), p.id);
    expect(results.map((r) => [r.ok, r.reason])).toEqual([
      [true, undefined],
      [false, "quarantined item is missing"],
    ]);
    expect(w2.fs.exists(paths[0] as string)).toBe(true);
    expect(w2.fs.exists(paths[1] as string)).toBe(true);
  });
});

describe("listQuarantine and readManifest", () => {
  it("lists the authenticated manifest of an applied plan", async () => {
    const l = await listQuarantine({ quarantine: w.quarantine, fs: w.fs });
    expect(l.problems).toEqual([]);
    expect(l.manifests.map((m) => m.planId)).toEqual([plan.id]);
  });

  it("an empty quarantine lists nothing", async () => {
    const w2 = new DisposalWorld();
    expect(await listQuarantine({ quarantine: w2.quarantine, fs: w2.fs })).toEqual({ manifests: [], problems: [] });
  });

  it("reports a modified manifest, a missing manifest and a symlinked plan directory as problems and ignores other names", async () => {
    const emptyId = "plan-20260101T000000Z-eeeeeeee";
    const linkId = "plan-20260101T000000Z-cccccccc";
    w.fs.mkdir(`${QUARANTINE_ROOT}/${emptyId}`);
    w.fs.symlink(`${QUARANTINE_ROOT}/${linkId}`, "/elsewhere");
    w.fs.mkdir(`${QUARANTINE_ROOT}/not-a-plan`);
    w.quarantine.texts.set(plan.id, (w.quarantine.texts.get(plan.id) as string).replace('"size"', '"size": 1, "x"'));
    const l = await listQuarantine({ quarantine: w.quarantine, fs: w.fs });
    expect(l.manifests).toEqual([]);
    expect(l.problems.map((p) => p.planId)).toEqual([linkId, plan.id, emptyId].sort());
    expect(l.problems.find((p) => p.planId === emptyId)?.reason).toBe("no manifest");
    expect(l.problems.find((p) => p.planId === linkId)?.reason).toBe("not a real directory");
    expect(l.problems.find((p) => p.planId === plan.id)?.reason).toMatch(/manifest/);
  });

  it("readManifest returns null for a plan without a manifest and throws for a manifest that is not authentic", async () => {
    expect(await readManifest({ quarantine: w.quarantine }, "plan-20200101T000000Z-dddddddd")).toBeNull();
    w.vault.key = "another-key";
    await expect(readManifest({ quarantine: w.quarantine }, plan.id)).rejects.toThrow("manifest signature is invalid: it was modified");
    w.vault.key = null;
    await expect(readManifest({ quarantine: w.quarantine }, plan.id)).rejects.toThrow("approval key missing: cannot authenticate manifest");
  });

  it("rejects an id that is not a plan id", async () => {
    await expect(readManifest({ quarantine: w.quarantine }, "../etc")).rejects.toThrow("invalid plan id");
  });
});
