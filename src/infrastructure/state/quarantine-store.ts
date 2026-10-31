import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuarantineStore } from "../../application/ports/quarantine.js";
import type { KeyStore } from "../../application/ports/planning.js";
import { QuarantineError } from "../../domain/quarantine/errors.js";
import { assertPlanId, assertStoredName, Manifest } from "../../domain/quarantine/manifest.js";
import { safeJson } from "../../domain/shared/escape.js";

/**
 * Quarantine on disk: `<root>/<planId>/manifest.json` (sealed, mode 0600, replaced atomically) and
 * `<root>/<planId>/items/NNNN`. Manifests are sealed and authenticated with the per-user key.
 */
export class FileQuarantineStore implements QuarantineStore {
  constructor(
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

  manifestPath(planId: string): string {
    return join(this.planDir(planId), "manifest.json");
  }

  itemPath(planId: string, stored: string): string {
    assertStoredName(stored);
    return join(this.itemsDir(planId), stored);
  }

  async create(planId: string): Promise<void> {
    await mkdir(this.planDir(planId), { mode: 0o700 });
    await mkdir(this.itemsDir(planId), { mode: 0o700 });
  }

  async discard(planId: string): Promise<void> {
    await rmdir(this.itemsDir(planId)).catch(() => undefined);
    await rmdir(this.planDir(planId)).catch(() => undefined);
  }

  async planIds(): Promise<string[]> {
    try {
      return await readdir(this.rootDir);
    } catch {
      return [];
    }
  }

  async load(planId: string): Promise<Manifest | null> {
    let text: string;
    try {
      text = await readFile(this.manifestPath(planId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return Manifest.open(text, planId, await this.keys.signer(false));
  }

  async save(manifest: Manifest): Promise<void> {
    const signer = await this.keys.signer(true);
    if (!signer) throw new QuarantineError("approval key unavailable");
    const target = this.manifestPath(manifest.planId);
    const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, safeJson(manifest.seal(signer), 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(tmp, target);
  }

  async removeItem(planId: string, stored: string): Promise<void> {
    await rm(this.itemPath(planId, stored), { recursive: true, force: true });
  }
}
