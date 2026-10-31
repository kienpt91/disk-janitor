// Purge: the only way quarantined bytes are ever deleted. Which items are eligible is decided by
// the Manifest (age since quarantinedAt); the human gate lives in the CLI. Only paths derived from
// authenticated Manifest entries inside the Quarantine are touched.

import { join } from "node:path";
import { events } from "../domain/events.js";
import type { PurgeItem } from "../domain/quarantine/manifest.js";
import { listQuarantine, type QuarantineListing } from "./quarantine-listing.js";
import type { ApplyLock, Clock, EventPublisher, FileSystem } from "./ports/common.js";
import type { QuarantineStore } from "./ports/quarantine.js";

export interface PurgeResult {
  purged: PurgeItem[];
  failed: Array<{ item: PurgeItem; reason: string }>;
}

type ListPorts = { quarantine: QuarantineStore; fs: FileSystem };
/** `lock` is the same exclusive lock Apply and Restore hold, so only one of them changes the Quarantine at a time. */
export type PurgePorts = ListPorts & { clock: Clock; events: EventPublisher; lock: ApplyLock };

/** Items eligible for permanent deletion: listed in an authenticated Manifest, quarantined at least `ttlMs` ago. */
export async function purgeCandidates(
  ports: ListPorts,
  ttlMs: number,
  nowMs: number,
): Promise<{ items: PurgeItem[]; problems: QuarantineListing["problems"] }> {
  const { manifests, problems } = await listQuarantine(ports);
  return { items: manifests.flatMap((m) => m.purgeEligible(nowMs, ttlMs)), problems };
}

/** Permanently delete the given items. Publishes purge-* events. Holds the exclusive state lock throughout. */
export async function purgeItems(ports: PurgePorts, items: PurgeItem[]): Promise<PurgeResult> {
  const lease = await ports.lock.acquire();
  try {
    return await purgeLocked(ports, items);
  } finally {
    await lease.release();
  }
}

async function purgeLocked(ports: PurgePorts, items: PurgeItem[]): Promise<PurgeResult> {
  const result: PurgeResult = { purged: [], failed: [] };
  const qReal = await ports.fs.realpath(ports.quarantine.rootDir);
  for (const item of items) {
    const manifest = await ports.quarantine.load(item.planId);
    const entry = manifest?.entryByStored(item.entry.stored);
    if (!manifest || !entry || entry.status !== "quarantined") {
      result.failed.push({ item, reason: "not a quarantined entry of an authenticated manifest" });
      continue;
    }
    const planId = manifest.planId;
    const itemsReal = await ports.fs.realpath(ports.quarantine.itemsDir(planId)).catch(() => null);
    if (!itemsReal || itemsReal !== join(qReal, planId, "items")) {
      result.failed.push({ item, reason: "items directory is not where the manifest says" });
      continue;
    }
    await ports.events.publish(events.purgeBegan({ planId, stored: entry.stored, path: entry.originalPath, size: entry.size }));
    try {
      await ports.quarantine.removeItem(planId, entry.stored);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      await ports.events.publish(events.purgeFailed({ planId, stored: entry.stored, reason: code }));
      result.failed.push({ item, reason: `delete failed (${code})` });
      continue;
    }
    // build on what is stored now, never on the snapshot read before the deletion
    const updated = ((await ports.quarantine.load(planId)) ?? manifest).markPurged(entry.index, ports.clock.now());
    await ports.quarantine.save(updated);
    await ports.events.publish(events.purgeDone({ planId, stored: entry.stored, path: entry.originalPath }));
    result.purged.push({ ...item, entry: updated.entry(entry.index) as PurgeItem["entry"] });
  }
  return result;
}
