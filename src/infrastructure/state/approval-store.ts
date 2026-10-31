import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalStore } from "../../application/ports/planning.js";
import type { State } from "./state-dir.js";

const HEX64 = /^[0-9a-f]{64}$/;

export function approvalPath(state: State, planDigest: string): string {
  if (!HEX64.test(planDigest)) throw new Error("invalid plan digest");
  return join(state.approvalsDir, `${planDigest}.json`);
}

/** ApprovalStore adapter: one 0600 file per plan digest, written atomically (temp file + rename). */
export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly state: State) {}

  async write(planDigest: string, text: string): Promise<void> {
    const target = approvalPath(this.state, planDigest);
    const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
    await rename(tmp, target);
  }

  async read(planDigest: string): Promise<string | null> {
    try {
      return await readFile(approvalPath(this.state, planDigest), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async remove(planDigest: string): Promise<void> {
    await unlink(approvalPath(this.state, planDigest));
  }
}
