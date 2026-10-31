import { PLAN_ID_RE } from "../domain/plan/plan.js";
import type { Manifest } from "../domain/quarantine/manifest.js";
import type { FileSystem } from "./ports/common.js";
import type { QuarantineStore } from "./ports/quarantine.js";

export interface QuarantineListing {
  manifests: Manifest[];
  /** Plan directories that could not be trusted, with why; their entries are hidden. */
  problems: Array<{ planId: string; reason: string }>;
}

/** The authenticated Manifest of a Plan; null when it has none. Throws QuarantineError on tampering. */
export function readManifest(ports: { quarantine: QuarantineStore }, planId: string): Promise<Manifest | null> {
  return ports.quarantine.load(planId);
}

/** Every Plan directory in Quarantine, authenticated. Untrustworthy ones are reported, never read. */
export async function listQuarantine(ports: { quarantine: QuarantineStore; fs: FileSystem }): Promise<QuarantineListing> {
  const out: QuarantineListing = { manifests: [], problems: [] };
  const names = (await ports.quarantine.planIds()).sort();
  for (const name of names) {
    if (!PLAN_ID_RE.test(name)) continue;
    const st = await ports.fs.lstat(ports.quarantine.planDir(name));
    if (!st.isDirectory() || st.isSymbolicLink()) {
      out.problems.push({ planId: name, reason: "not a real directory" });
      continue;
    }
    try {
      const m = await ports.quarantine.load(name);
      if (m) out.manifests.push(m);
      else out.problems.push({ planId: name, reason: "no manifest" });
    } catch (e) {
      out.problems.push({ planId: name, reason: (e as Error).message });
    }
  }
  return out;
}
