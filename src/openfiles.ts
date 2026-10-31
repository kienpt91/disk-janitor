import type { CommandRunner } from "./deps.js";
import { isInside } from "./paths.js";

export interface OpenFileIndex {
  /** False when lsof is missing or produced nothing usable: the check was not performed. */
  available: boolean;
  names: string[];
}

/**
 * Best effort: one `lsof` run lists every open file and working directory the current user can
 * see. Candidates with an open path beneath them are skipped. Without lsof this protection is off.
 */
export async function loadOpenFiles(run: CommandRunner): Promise<OpenFileIndex> {
  const res = await run("lsof", ["-nP", "-w", "-F", "n"], { timeoutMs: 30_000 });
  if (res.error || res.stdout.length === 0) return { available: false, names: [] };
  const names: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("n/")) names.push(line.slice(1));
  }
  return { available: true, names };
}

/** First open path inside `path` (or equal to it), or null. */
export function openPathUnder(index: OpenFileIndex, path: string): string | null {
  for (const n of index.names) {
    if (isInside(path, n)) return n;
  }
  return null;
}
