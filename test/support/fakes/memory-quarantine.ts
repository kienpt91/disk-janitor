import { join } from "node:path";
import type { QuarantineStore } from "../../../src/application/ports/quarantine.js";
import type { KeyStore } from "../../../src/application/ports/planning.js";
import { QuarantineError } from "../../../src/domain/quarantine/errors.js";
import { assertPlanId, assertStoredName, Manifest } from "../../../src/domain/quarantine/manifest.js";
import { safeJson } from "../../../src/domain/shared/escape.js";
import type { MemoryFileSystem } from "./memory-fs.js";

function errno(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/**
 * QuarantineStore over a MemoryFileSystem: directories and items live in the file system, sealed
 * manifest texts in a map (as the real adapter keeps them in manifest.json).
 */
export class MemoryQuarantineStore implements QuarantineStore {
  /** Sealed manifest text per plan id. */
  readonly texts = new Map<string, string>();
  /** Fail the next `removeItem` calls with this error code (test seam). */
  failRemoval: string | null = null;
  /** Fail `save` once with this error code (test seam). */
  failSave: string | null = null;
  readonly removed: string[] = [];
  /** Saves that would have undone a status change already stored (a stale snapshot overwrote newer state). */
  readonly lostUpdates: string[] = [];
  /** Runs after every successful `load` (test seam for interleaving another writer). */
  afterLoad: ((planId: string) => Promise<void> | void) | null = null;

  constructor(
    private readonly fs: MemoryFileSystem,
    readonly rootDir: string,
    private readonly keys: KeyStore,
  ) {}

  planDir(planId: string): string {
    assertPlanId(planId);
    return join(this.rootDir, planId);
  }

  itemsDir(planId: string): string {
    return join(this.planDir(planId), "items");
  }

  itemPath(planId: string, stored: string): string {
    assertStoredName(stored);
    return join(this.itemsDir(planId), stored);
  }

  async create(planId: string): Promise<void> {
    const dir = this.planDir(planId);
    if (this.fs.exists(dir)) throw errno("EEXIST", `file already exists, mkdir '${dir}'`);
    this.fs.mkdir(dir).mkdir(this.itemsDir(planId));
  }

  async discard(planId: string): Promise<void> {
    const items = this.itemsDir(planId);
    if (this.fs.exists(items) && this.fs.list(items).length === 0) this.fs.remove(items);
    const dir = this.planDir(planId);
    if (this.fs.exists(dir) && this.fs.list(dir).length === 0) this.fs.remove(dir);
  }

  async planIds(): Promise<string[]> {
    return this.fs.exists(this.rootDir) ? this.fs.list(this.rootDir) : [];
  }

  async load(planId: string): Promise<Manifest | null> {
    assertPlanId(planId);
    const text = this.texts.get(planId);
    if (text === undefined || !this.fs.exists(this.planDir(planId))) return null;
    const loaded = Manifest.open(text, planId, await this.keys.signer(false));
    await this.afterLoad?.(planId);
    return loaded;
  }

  async save(manifest: Manifest): Promise<void> {
    if (this.failSave) {
      const code = this.failSave;
      this.failSave = null;
      throw errno(code, "save failed");
    }
    const signer = await this.keys.signer(true);
    if (!signer) throw new QuarantineError("approval key unavailable");
    if (!this.fs.exists(this.planDir(manifest.planId))) throw errno("ENOENT", `no such file or directory, open '${this.planDir(manifest.planId)}'`);
    const stored = this.texts.get(manifest.planId);
    if (stored !== undefined) {
      const before = (JSON.parse(stored) as { entries: Array<{ index: number; status: string }> }).entries;
      for (const e of before) {
        const now = manifest.entry(e.index)?.status;
        if ((e.status === "restored" || e.status === "purged") && now !== e.status) this.lostUpdates.push(`${manifest.planId}#${e.index}: ${e.status} -> ${now}`);
      }
    }
    this.texts.set(manifest.planId, safeJson(manifest.seal(signer), 2) + "\n");
  }

  async removeItem(planId: string, stored: string): Promise<void> {
    const path = this.itemPath(planId, stored);
    if (this.failRemoval) throw errno(this.failRemoval, `cannot remove '${path}'`);
    if (this.fs.exists(path)) this.fs.remove(path);
    this.removed.push(path);
  }
}

