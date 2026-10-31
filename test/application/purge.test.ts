import { beforeEach, describe, expect, it } from "vitest";
import { purgeCandidates, purgeItems } from "../../src/application/purge.js";
import { readManifest } from "../../src/application/quarantine-listing.js";
import { restore } from "../../src/application/restore.js";
import type { Plan } from "../../src/domain/model/types.js";
import { DAY_MS } from "../../src/domain/model/types.js";
import { QuarantineError } from "../../src/domain/quarantine/errors.js";
import { purgeSetDigest } from "../../src/domain/quarantine/manifest.js";
import { DisposalWorld, QUARANTINE_ROOT } from "../support/disposal-world.js";

const TTL = 7 * DAY_MS;
let w: DisposalWorld;
let nms: string[];
let plan: Plan;
let appliedAt: number;

beforeEach(async () => {
  w = new DisposalWorld();
  nms = [w.project("a", 12_000), w.project("b", 8_000), w.project("c", 4_000)];
  ({ plan } = await w.applied(nms));
  appliedAt = w.clock.now();
});

const listPorts = () => ({ quarantine: w.quarantine, fs: w.fs });
const purgeEvents = async () => (await w.events()).filter((e) => e.name.startsWith("purge-"));

describe("purgeCandidates: purge TTL", () => {
  it("nothing is eligible before the TTL and everything is eligible exactly at it", async () => {
    expect((await purgeCandidates(listPorts(), TTL, appliedAt + TTL - 1)).items).toEqual([]);
    const { items, problems } = await purgeCandidates(listPorts(), TTL, appliedAt + TTL);
    expect(problems).toEqual([]);
    expect(items.map((i) => [i.planId, i.entry.stored, i.ageDays])).toEqual([[plan.id, "0001", 7], [plan.id, "0002", 7], [plan.id, "0003", 7]]);
  });

  it("a zero TTL makes quarantined entries eligible at once", async () => {
    expect((await purgeCandidates(listPorts(), 0, appliedAt)).items).toHaveLength(3);
  });

  it("restored entries are not candidates, and a manifest of another plan is listed too", async () => {
    await restore(w.disposalPorts(), nms[0] as string);
    w.fs.writeFile(`${nms[0]}/dep/index.js`);
    const second = await w.plan([nms[0] as string]);
    await w.approve(second);
    await w.apply(second);
    const { items } = await purgeCandidates(listPorts(), 0, w.clock.now());
    expect(items.map((i) => [i.planId, i.entry.stored])).toEqual([[plan.id, "0002"], [plan.id, "0003"], [second.id, "0001"]].sort((a, b) => (a[0] as string).localeCompare(b[0] as string)));
  });

  it("an untrustworthy manifest contributes no items, only a problem", async () => {
    w.vault.key = "another-key";
    const { items, problems } = await purgeCandidates(listPorts(), 0, appliedAt);
    expect(items).toEqual([]);
    expect(problems).toEqual([{ planId: plan.id, reason: "manifest signature is invalid: it was modified" }]);
  });

  it("is empty for an empty quarantine", async () => {
    const w2 = new DisposalWorld();
    expect(await purgeCandidates({ quarantine: w2.quarantine, fs: w2.fs }, 0, 0)).toEqual({ items: [], problems: [] });
  });
});

describe("purgeItems", () => {
  it("deletes exactly the listed items, marks them purged at the clock time and publishes purge-begin/purge-done", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    w.clock.advance(1_000);
    const res = await purgeItems(w.disposalPorts(), [items[1] as (typeof items)[number]]);
    expect(res.failed).toEqual([]);
    expect(res.purged).toHaveLength(1);
    expect(res.purged[0]?.entry).toMatchObject({ stored: "0002", status: "purged", purgedAt: w.clock.now() });
    expect(w.fs.exists(w.itemPath(plan, 2))).toBe(false);
    expect(w.fs.exists(w.itemPath(plan, 1))).toBe(true);
    expect(w.fs.exists(w.itemPath(plan, 3))).toBe(true);
    expect((await readManifest({ quarantine: w.quarantine }, plan.id))?.entries.map((e) => e.status)).toEqual(["quarantined", "purged", "quarantined"]);
    expect(await purgeEvents()).toEqual([
      { name: "purge-begin", data: { planId: plan.id, stored: "0002", path: nms[1], size: plan.candidates[1]?.size } },
      { name: "purge-done", data: { planId: plan.id, stored: "0002", path: nms[1] } },
    ]);
  });

  it("a purged item never comes back: it is no longer a restore or purge candidate", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    await purgeItems(w.disposalPorts(), items);
    expect((await purgeCandidates(listPorts(), 0, appliedAt)).items).toEqual([]);
    expect((await restore(w.disposalPorts(), plan.id))).toEqual([]);
    expect(w.fs.list(`${QUARANTINE_ROOT}/${plan.id}/items`)).toEqual([]);
  });

  it("only paths derived from manifest entries are touched: an untracked item in the items directory survives", async () => {
    w.fs.writeFile(`${QUARANTINE_ROOT}/${plan.id}/items/0099/keep.txt`);
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    await purgeItems(w.disposalPorts(), items);
    expect(w.fs.exists(`${QUARANTINE_ROOT}/${plan.id}/items/0099/keep.txt`)).toBe(true);
    expect(w.quarantine.removed).toEqual([1, 2, 3].map((i) => w.itemPath(plan, i)));
  });

  it("purging twice fails the second time without deleting anything", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    await purgeItems(w.disposalPorts(), [items[0] as (typeof items)[number]]);
    const again = await purgeItems(w.disposalPorts(), [items[0] as (typeof items)[number]]);
    expect(again.purged).toEqual([]);
    expect(again.failed).toEqual([{ item: items[0], reason: "not a quarantined entry of an authenticated manifest" }]);
    expect(w.quarantine.removed).toHaveLength(1);
    expect((await purgeEvents()).map((e) => e.name)).toEqual(["purge-begin", "purge-done"]);
  });

  it("an item restored after the purge list was made cannot be purged through that list", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    await restore(w.disposalPorts(), nms[0] as string);
    const res = await purgeItems(w.disposalPorts(), items);
    expect(res.failed.map((f) => f.item.entry.stored)).toEqual(["0001"]);
    expect(res.purged.map((p) => p.entry.stored)).toEqual(["0002", "0003"]);
    expect(w.fs.exists(nms[0] as string)).toBe(true);
  });

  it("an item whose plan has no manifest is refused", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    const orphan = { ...(items[0] as (typeof items)[number]), planId: "plan-20200101T000000Z-dddddddd" };
    const res = await purgeItems(w.disposalPorts(), [orphan]);
    expect(res.failed).toEqual([{ item: orphan, reason: "not a quarantined entry of an authenticated manifest" }]);
  });

  it("a stored name the manifest does not list is refused", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    const forged = { ...(items[0] as (typeof items)[number]), entry: { ...(items[0] as (typeof items)[number]).entry, stored: "0042" } };
    const res = await purgeItems(w.disposalPorts(), [forged]);
    expect(res.failed[0]?.reason).toBe("not a quarantined entry of an authenticated manifest");
  });

  it("refuses everything when the manifest is not authentic: nothing is deleted and no event is published", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    w.vault.key = "another-key";
    await expect(purgeItems(w.disposalPorts(), items)).rejects.toBeInstanceOf(QuarantineError);
    for (const i of [1, 2, 3]) expect(w.fs.exists(w.itemPath(plan, i))).toBe(true);
    expect(await purgeEvents()).toEqual([]);
  });

  it("refuses when the items directory is a symlink to somewhere else: the victim survives", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    for (const n of ["0001", "0002", "0003"]) w.fs.writeFile(`/victim/${n}/data.txt`);
    const itemsDir = `${QUARANTINE_ROOT}/${plan.id}/items`;
    w.fs.remove(itemsDir);
    w.fs.symlink(itemsDir, "/victim");
    const res = await purgeItems(w.disposalPorts(), items);
    expect(res.purged).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual(Array(3).fill("items directory is not where the manifest says"));
    expect(w.fs.exists("/victim/0001/data.txt")).toBe(true);
    expect(w.quarantine.removed).toEqual([]);
    expect(await purgeEvents()).toEqual([]);
  });

  it("refuses when the items directory is gone", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    w.fs.remove(`${QUARANTINE_ROOT}/${plan.id}/items`);
    const res = await purgeItems(w.disposalPorts(), items);
    expect(res.failed.map((f) => f.reason)).toEqual(Array(3).fill("items directory is not where the manifest says"));
  });

  it("a deletion that fails is reported (purge-failed with the code), keeps the entry quarantined and continues", async () => {
    const { items } = await purgeCandidates(listPorts(), 0, appliedAt);
    w.quarantine.failRemoval = "EBUSY";
    const first = await purgeItems(w.disposalPorts(), [items[0] as (typeof items)[number]]);
    expect(first.purged).toEqual([]);
    expect(first.failed).toEqual([{ item: items[0], reason: "delete failed (EBUSY)" }]);
    expect((await purgeEvents()).map((e) => [e.name, e.data["reason"]])).toEqual([["purge-begin", undefined], ["purge-failed", "EBUSY"]]);
    expect((await readManifest({ quarantine: w.quarantine }, plan.id))?.entries[0]?.status).toBe("quarantined");
    w.quarantine.failRemoval = null;
    const retry = await purgeItems(w.disposalPorts(), items);
    expect(retry.purged).toHaveLength(3);
  });

  it("an empty list purges nothing", async () => {
    expect(await purgeItems(w.disposalPorts(), [])).toEqual({ purged: [], failed: [] });
  });
});

describe("purge set digest (what the human confirms)", () => {
  it("identifies the set of items and not their ages", async () => {
    const early = await purgeCandidates(listPorts(), 0, appliedAt);
    const late = await purgeCandidates(listPorts(), 0, appliedAt + 30 * DAY_MS);
    expect(purgeSetDigest(early.items)).toBe(purgeSetDigest(late.items));
    expect(purgeSetDigest(early.items.slice(1))).not.toBe(purgeSetDigest(early.items));
  });
});
