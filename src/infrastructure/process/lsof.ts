import type { OpenFilesPort } from "../../application/ports/discovery.js";
import type { CommandRunner } from "./command-runner.js";

export const LSOF_ARGS = ["-nP", "-w", "-F", "n"] as const;

/**
 * OpenFilesPort over `lsof`: one run lists every open file and working directory the current user
 * can see. Without lsof (or with no output) the snapshot is unavailable and the check is off.
 */
export function createLsof(run: CommandRunner): OpenFilesPort {
  return {
    async snapshot() {
      const res = await run("lsof", LSOF_ARGS, { timeoutMs: 30_000 });
      if (res.error || res.stdout.length === 0) return { available: false, names: [] };
      const names: string[] = [];
      for (const line of res.stdout.split("\n")) {
        if (line.startsWith("n/")) names.push(line.slice(1));
      }
      return { available: true, names };
    },
  };
}
