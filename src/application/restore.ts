// Restore: faithful undo. Each quarantined item is renamed back to its original path; nothing is
// ever overwritten and nothing is restored unless the authenticated Manifest and the file system
// agree on what the item is.

import { events } from "../domain/events.js";
import { PLAN_ID_RE } from "../domain/plan/plan.js";
import { isRestorableEntry, type Manifest, type ManifestEntry } from "../domain/quarantine/manifest.js";
import { restoreParent, restoreRefusal, type OriginalFact, type ParentFact, type StoredItemFact } from "../domain/quarantine/restore-rules.js";
import { findSymlinkInChain } from "./inspection.js";
import { listQuarantine } from "./quarantine-listing.js";
import type { Clock, EventPublisher, FileSystem } from "./ports/common.js";
import type { QuarantineStore } from "./ports/quarantine.js";

export interface RestoreCheck {
  planId: string;
  entry: ManifestEntry;
  ok: boolean;
  reason?: string;
}

export interface RestoreTarget {
  manifest: Manifest;
  entries: ManifestEntry[];
}

type LookupPorts = { quarantine: QuarantineStore; fs: FileSystem };
export type RestorePorts = LookupPorts & { clock: Clock; events: EventPublisher };

/** Restorable entries of the Plan named by `selector`, or of every Plan holding an item whose original path is `selector`. */
export async function findRestoreTargets(ports: LookupPorts, selector: string): Promise<RestoreTarget[]> {
  const { manifests } = await listQuarantine(ports);
  const out: RestoreTarget[] = [];
  if (PLAN_ID_RE.test(selector)) {
    const m = manifests.find((x) => x.planId === selector);
    if (m) out.push({ manifest: m, entries: m.entries.filter(isRestorableEntry) });
    return out;
  }
  for (const m of manifests) {
    const entries = m.restorableAt(selector);
    if (entries.length > 0) out.push({ manifest: m, entries });
  }
  return out;
}

async function observe(ports: LookupPorts, m: Manifest, entry: ManifestEntry) {
  const stored = ports.quarantine.itemPath(m.planId, entry.stored);
  let item: StoredItemFact;
  try {
    const st = await ports.fs.lstat(stored);
    item = { present: true, directory: st.isDirectory(), symlink: st.isSymbolicLink(), dev: st.dev, ino: st.ino };
  } catch {
    item = { present: false };
  }
  let parent: ParentFact;
  try {
    parent = (await findSymlinkInChain(ports.fs, restoreParent(entry), true)) ? "link" : "ok";
  } catch {
    parent = "missing";
  }
  let original: OriginalFact = "present";
  try {
    await ports.fs.lstat(entry.originalPath);
  } catch (e) {
    original = (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "uninspectable";
  }
  return { item, parent, original };
}

async function checkRestorable(ports: LookupPorts, m: Manifest, entry: ManifestEntry): Promise<string | null> {
  return restoreRefusal(m.scope, entry, await observe(ports, m, entry));
}

/** What restore would do, without doing it. */
export async function previewRestore(ports: LookupPorts, selector: string): Promise<RestoreCheck[]> {
  const out: RestoreCheck[] = [];
  for (const { manifest, entries } of await findRestoreTargets(ports, selector)) {
    for (const entry of entries) {
      const reason = await checkRestorable(ports, manifest, entry);
      out.push({ planId: manifest.planId, entry, ok: reason === null, ...(reason ? { reason } : {}) });
    }
  }
  return out;
}

/** Rename each quarantined item back to its original path; never overwrite. Publishes restore-* events. */
export async function restore(ports: RestorePorts, selector: string): Promise<RestoreCheck[]> {
  const results: RestoreCheck[] = [];
  for (const { manifest, entries } of await findRestoreTargets(ports, selector)) {
    let current = manifest;
    for (const entry of entries) {
      const planId = current.planId;
      const reason = await checkRestorable(ports, current, entry);
      if (reason) {
        await ports.events.publish(events.restoreRefused({ planId, path: entry.originalPath, reason }));
        results.push({ planId, entry, ok: false, reason });
        continue;
      }
      await ports.events.publish(events.restoreBegan({ planId, path: entry.originalPath }));
      try {
        await ports.fs.rename(ports.quarantine.itemPath(planId, entry.stored), entry.originalPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "error";
        await ports.events.publish(events.restoreFailed({ planId, path: entry.originalPath, reason: code }));
        results.push({ planId, entry, ok: false, reason: `rename failed (${code})` });
        continue;
      }
      current = current.markRestored(entry.index, ports.clock.now());
      await ports.quarantine.save(current);
      await ports.events.publish(events.restoreDone({ planId, path: entry.originalPath }));
      results.push({ planId, entry: current.entry(entry.index) as ManifestEntry, ok: true });
    }
  }
  return results;
}
