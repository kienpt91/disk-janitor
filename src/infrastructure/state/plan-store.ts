import { constants, lstat, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PlanStore } from "../../application/ports/planning.js";
import { MAX_PLAN_BYTES, PLAN_ID_RE } from "../../domain/plan/plan.js";
import type { State } from "./state-dir.js";

/** Write plan text with mode 0600, refusing to overwrite an existing file. */
export async function writePlanText(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
}

/** PlanStore adapter: plans are 0600 JSON files in the state directory (or an explicit path). */
export class FilePlanStore implements PlanStore {
  constructor(private readonly state: State) {}

  async write(planId: string, text: string, outPath?: string): Promise<string> {
    const path = outPath ? resolve(outPath) : join(this.state.plansDir, `${planId}.json`);
    await writePlanText(path, text);
    return path;
  }

  async read(ref: string, cwd: string): Promise<string> {
    const path = PLAN_ID_RE.test(ref) ? join(this.state.plansDir, `${ref}.json`) : resolve(cwd, ref);
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("plan is not a regular file");
    if (st.size > MAX_PLAN_BYTES) throw new Error("plan file is too large");
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      return await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  }
}
