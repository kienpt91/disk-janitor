import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AuditLog } from "./audit.js";
import { baseFor } from "./bases.js";
import { canonicalJson } from "./domain/shared/canonical.js";
import type { Deps } from "./composition/deps.js";
import { safeJson } from "./domain/shared/escape.js";
import { isCanonicalAbsolute } from "./domain/shared/paths.js";
import { findSymlinkInChain } from "./application/inspection.js";
import { PLAN_ID_RE } from "./plan.js";
import { protectedReason } from "./domain/policy/protected.js";
import { arr, int, literal, obj, opt, parseJson, SchemaError, str, type Infer, type Parser } from "./domain/shared/schema.js";
import { loadKey, type State } from "./state.js";
import { DETECTOR_IDS, DAY_MS } from "./domain/model/types.js";

export const DEFAULT_PURGE_TTL_DAYS = 7;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export class QuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineError";
  }
}

const canonicalPath: Parser<string> = (v, p) => {
  const s = str({ min: 1, max: 4096 })(v, p);
  if (!isCanonicalAbsolute(s)) throw new SchemaError(`${p}: not a canonical absolute path`);
  return s;
};

const entryParser = obj({
  index: int({ min: 1, max: 100_000 }),
  stored: str({ pattern: /^[0-9]{4,6}$/, max: 6 }),
  originalPath: canonicalPath,
  detector: literal(...DETECTOR_IDS),
  dev: str({ pattern: /^[0-9]{1,20}$/ }),
  ino: str({ pattern: /^[0-9]{1,20}$/ }),
  size: int(),
  mtimeMs: int(),
  status: literal("pending", "quarantined", "restored", "purged"),
  quarantinedAt: opt(int()),
  restoredAt: opt(int()),
  purgedAt: opt(int()),
});

const manifestParser = obj({
  version: literal(1),
  planId: str({ pattern: PLAN_ID_RE }),
  planDigest: str({ pattern: HEX64 }),
  createdAt: int(),
  roots: arr(canonicalPath, { max: 64 }),
  home: canonicalPath,
  detectors: arr(literal(...DETECTOR_IDS), { max: 16 }),
  entries: arr(entryParser, { max: 5000 }),
  mac: str({ pattern: HEX64 }),
});

export type Manifest = Infer<typeof manifestParser>;
export type ManifestEntry = Manifest["entries"][number];

function manifestMac(key: Buffer, m: Omit<Manifest, "mac">): string {
  return createHmac("sha256", key).update("disk-janitor/manifest/v1\n" + canonicalJson(m)).digest("hex");
}

export function planQuarantineDir(state: State, planId: string): string {
  if (!PLAN_ID_RE.test(planId)) throw new QuarantineError("invalid plan id");
  return join(state.quarantineDir, planId);
}

export function itemsDir(state: State, planId: string): string {
  return join(planQuarantineDir(state, planId), "items");
}

export function manifestPath(state: State, planId: string): string {
  return join(planQuarantineDir(state, planId), "manifest.json");
}

export function itemPath(state: State, planId: string, stored: string): string {
  if (!/^[0-9]{4,6}$/.test(stored)) throw new QuarantineError("invalid stored item name");
  return join(itemsDir(state, planId), stored);
}

export async function writeManifest(state: State, manifest: Omit<Manifest, "mac">): Promise<void> {
  const key = await loadKey(state, true);
  if (!key) throw new QuarantineError("approval key unavailable");
  const full: Manifest = { ...manifest, mac: manifestMac(key, manifest) };
  const target = manifestPath(state, manifest.planId);
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, safeJson(full, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, target);
}

/** Read and authenticate a manifest. Returns null when the plan has no manifest. Throws on tampering. */
export async function readManifest(state: State, planId: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(manifestPath(state, planId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let m: Manifest;
  try {
    m = parseJson(text, manifestParser, MAX_MANIFEST_BYTES, "manifest");
  } catch (e) {
    throw new QuarantineError(e instanceof SchemaError ? e.message : "manifest unreadable");
  }
  if (m.planId !== planId) throw new QuarantineError("manifest belongs to a different plan");
  const key = await loadKey(state, false);
  if (!key) throw new QuarantineError("approval key missing: cannot authenticate manifest");
  const { mac, ...rest } = m;
  const expected = Buffer.from(manifestMac(key, rest), "hex");
  const given = Buffer.from(mac, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new QuarantineError("manifest signature is invalid: it was modified");
  }
  const seen = new Set<string>();
  for (const e of m.entries) {
    if (seen.has(e.stored)) throw new QuarantineError("manifest has duplicate stored names");
    seen.add(e.stored);
  }
  return m;
}

export interface QuarantineListing {
  manifests: Manifest[];
  problems: Array<{ planId: string; reason: string }>;
}

export async function listQuarantine(state: State): Promise<QuarantineListing> {
  const out: QuarantineListing = { manifests: [], problems: [] };
  let names: string[];
  try {
    names = await readdir(state.quarantineDir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!PLAN_ID_RE.test(name)) continue;
    const st = await lstat(join(state.quarantineDir, name));
    if (!st.isDirectory() || st.isSymbolicLink()) {
      out.problems.push({ planId: name, reason: "not a real directory" });
      continue;
    }
    try {
      const m = await readManifest(state, name);
      if (m) out.manifests.push(m);
      else out.problems.push({ planId: name, reason: "no manifest" });
    } catch (e) {
      out.problems.push({ planId: name, reason: (e as Error).message });
    }
  }
  return out;
}

export interface RestoreCheck {
  planId: string;
  entry: ManifestEntry;
  ok: boolean;
  reason?: string;
}

async function checkRestorable(state: State, deps: Deps, m: Manifest, entry: ManifestEntry): Promise<string | null> {
  if (entry.status !== "quarantined" && entry.status !== "pending") return `status is ${entry.status}`;
  const stored = itemPath(state, m.planId, entry.stored);
  let st;
  try {
    st = await lstat(stored, { bigint: true });
  } catch {
    return "quarantined item is missing";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "quarantined item is not a directory any more";
  if (st.ino.toString() !== entry.ino || st.dev.toString() !== entry.dev) return "quarantined item changed (inode mismatch)";
  const base = baseFor({ roots: m.roots, home: m.home, detectors: m.detectors }, entry.originalPath);
  if (!base) return "original path is outside the roots recorded in the manifest";
  const prot = protectedReason(entry.originalPath, [m.home]);
  if (prot) return prot;
  const parent = entry.originalPath.slice(0, entry.originalPath.lastIndexOf(sep)) || sep;
  let link: string | null;
  try {
    link = await findSymlinkInChain(deps.fs, parent, true);
  } catch {
    return "parent directory does not exist";
  }
  if (link) return "a parent path component is a symlink or not a directory";
  let existing = null;
  try {
    existing = await deps.fs.lstat(entry.originalPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return "cannot inspect the original path";
  }
  if (existing) return "something already exists at the original path; refusing to overwrite";
  return null;
}

/** Entries of a quarantine matching a plan id or an exact original path. */
export async function findRestoreTargets(
  state: State,
  selector: string,
): Promise<{ manifest: Manifest; entries: ManifestEntry[] }[]> {
  const { manifests } = await listQuarantine(state);
  const out: { manifest: Manifest; entries: ManifestEntry[] }[] = [];
  if (PLAN_ID_RE.test(selector)) {
    const m = manifests.find((x) => x.planId === selector);
    if (m) out.push({ manifest: m, entries: m.entries.filter((e) => e.status === "quarantined" || e.status === "pending") });
    return out;
  }
  for (const m of manifests) {
    const entries = m.entries.filter((e) => e.originalPath === selector && (e.status === "quarantined" || e.status === "pending"));
    if (entries.length > 0) out.push({ manifest: m, entries });
  }
  return out;
}

export async function previewRestore(state: State, deps: Deps, selector: string): Promise<RestoreCheck[]> {
  const targets = await findRestoreTargets(state, selector);
  const out: RestoreCheck[] = [];
  for (const { manifest, entries } of targets) {
    for (const entry of entries) {
      const reason = await checkRestorable(state, deps, manifest, entry);
      out.push({ planId: manifest.planId, entry, ok: reason === null, ...(reason ? { reason } : {}) });
    }
  }
  return out;
}

/** Faithful undo: rename each quarantined item back to its original path; never overwrite. */
export async function restore(state: State, deps: Deps, audit: AuditLog, selector: string): Promise<RestoreCheck[]> {
  const targets = await findRestoreTargets(state, selector);
  const results: RestoreCheck[] = [];
  for (const { manifest, entries } of targets) {
    let current = manifest;
    for (const entry of entries) {
      const reason = await checkRestorable(state, deps, current, entry);
      if (reason) {
        await audit.append("restore-refused", { planId: current.planId, path: entry.originalPath, reason });
        results.push({ planId: current.planId, entry, ok: false, reason });
        continue;
      }
      await audit.append("restore-begin", { planId: current.planId, path: entry.originalPath });
      try {
        await deps.fs.rename(itemPath(state, current.planId, entry.stored), entry.originalPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "error";
        await audit.append("restore-failed", { planId: current.planId, path: entry.originalPath, reason: code });
        results.push({ planId: current.planId, entry, ok: false, reason: `rename failed (${code})` });
        continue;
      }
      const updated = { ...entry, status: "restored" as const, restoredAt: deps.now() };
      current = { ...current, entries: current.entries.map((x) => (x.index === entry.index ? updated : x)) };
      const { mac: _mac, ...body } = current;
      await writeManifest(state, body);
      await audit.append("restore-done", { planId: current.planId, path: entry.originalPath });
      results.push({ planId: current.planId, entry: updated, ok: true });
    }
  }
  return results;
}

export interface PurgeItem {
  planId: string;
  entry: ManifestEntry;
  ageDays: number;
}

/** Items eligible for permanent deletion: listed in an authenticated manifest, quarantined at least `ttlMs` ago. */
export async function purgeCandidates(state: State, ttlMs: number, nowMs: number): Promise<{ items: PurgeItem[]; problems: QuarantineListing["problems"] }> {
  const { manifests, problems } = await listQuarantine(state);
  const items: PurgeItem[] = [];
  for (const m of manifests) {
    for (const entry of m.entries) {
      if (entry.status !== "quarantined" || entry.quarantinedAt === undefined) continue;
      const age = nowMs - entry.quarantinedAt;
      if (age >= ttlMs) items.push({ planId: m.planId, entry, ageDays: Math.floor(age / DAY_MS) });
    }
  }
  return { items, problems };
}

/** Stable identifier of a purge set; the human types its prefix to confirm. */
export function purgeSetDigest(items: PurgeItem[]): string {
  const ids = items.map((i) => `${i.planId}:${i.entry.stored}`).sort();
  return createHash("sha256").update("disk-janitor/purge/v1\n" + ids.join("\n")).digest("hex");
}

export interface PurgeResult {
  purged: PurgeItem[];
  failed: Array<{ item: PurgeItem; reason: string }>;
}

/** Permanently delete the given items. Only paths derived from manifest entries inside the quarantine are touched. */
export async function purgeItems(state: State, deps: Deps, audit: AuditLog, items: PurgeItem[]): Promise<PurgeResult> {
  const result: PurgeResult = { purged: [], failed: [] };
  const qReal = await realpath(state.quarantineDir);
  for (const item of items) {
    const manifest = await readManifest(state, item.planId);
    const entry = manifest?.entries.find((e) => e.stored === item.entry.stored);
    if (!manifest || !entry || entry.status !== "quarantined") {
      result.failed.push({ item, reason: "not a quarantined entry of an authenticated manifest" });
      continue;
    }
    const target = itemPath(state, manifest.planId, entry.stored);
    const itemsReal = await realpath(itemsDir(state, manifest.planId)).catch(() => null);
    if (!itemsReal || itemsReal !== join(qReal, manifest.planId, "items")) {
      result.failed.push({ item, reason: "items directory is not where the manifest says" });
      continue;
    }
    await audit.append("purge-begin", { planId: manifest.planId, stored: entry.stored, path: entry.originalPath, size: entry.size });
    try {
      await rm(target, { recursive: true, force: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      await audit.append("purge-failed", { planId: manifest.planId, stored: entry.stored, reason: code });
      result.failed.push({ item, reason: `delete failed (${code})` });
      continue;
    }
    const updated = { ...entry, status: "purged" as const, purgedAt: deps.now() };
    const { mac: _mac, ...rest } = manifest;
    await writeManifest(state, { ...rest, entries: manifest.entries.map((x) => (x.index === entry.index ? updated : x)) });
    await audit.append("purge-done", { planId: manifest.planId, stored: entry.stored, path: entry.originalPath });
    result.purged.push({ ...item, entry: updated });
  }
  return result;
}

export async function ensureQuarantineDirs(state: State, planId: string): Promise<void> {
  await mkdir(planQuarantineDir(state, planId), { mode: 0o700 });
  await mkdir(itemsDir(state, planId), { mode: 0o700 });
}
