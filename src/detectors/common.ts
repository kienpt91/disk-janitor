import type { Config } from "../config.js";
import type { Deps } from "../composition/deps.js";
import { analyzeTree } from "../analyze.js";
import { openPathUnder, type OpenFileIndex } from "../openfiles.js";
import { protectedReason } from "../domain/policy/protected.js";
import { DAY_MS, type DetectorId, type FsCandidate, type ReportItem, type SkippedItem } from "../domain/model/types.js";

export const MAX_SKIPPED = 2000;

export interface ScanCtx {
  config: Config;
  deps: Deps;
  open: OpenFileIndex;
  /** Canonical home directories used by the protected-path rules. */
  homes: string[];
  candidates: Array<Omit<FsCandidate, "id">>;
  reports: ReportItem[];
  skipped: SkippedItem[];
  skippedCount: number;
  warnings: string[];
}

export function skip(ctx: ScanCtx, detector: DetectorId, path: string, reason: string): void {
  ctx.skippedCount++;
  if (ctx.skipped.length < MAX_SKIPPED) ctx.skipped.push({ detector, path, reason });
}

export interface EvalSpec {
  detector: DetectorId;
  path: string;
  /** Device of the root (or home, for caches) the candidate must stay on. */
  baseDev: bigint;
  strict: boolean;
  /** Latest known activity, ms. The newest mtime inside the candidate is folded in. */
  activityMs: number;
  minAgeDays: number;
  reasonFor: (ageDays: number) => string;
  regenerate: string;
}

/** Shared checks for every file-system candidate. Returns true when it was accepted. */
export async function evaluateFsCandidate(ctx: ScanCtx, spec: EvalSpec): Promise<boolean> {
  const { deps, config } = ctx;
  let st;
  try {
    st = await deps.fs.lstat(spec.path);
  } catch {
    skip(ctx, spec.detector, spec.path, "cannot stat");
    return false;
  }
  if (st.isSymbolicLink()) {
    skip(ctx, spec.detector, spec.path, "is a symlink (never followed)");
    return false;
  }
  if (!st.isDirectory()) {
    skip(ctx, spec.detector, spec.path, "is not a directory");
    return false;
  }
  const prot = protectedReason(spec.path, ctx.homes);
  if (prot) {
    skip(ctx, spec.detector, spec.path, prot);
    return false;
  }
  if (st.dev !== spec.baseDev) {
    skip(ctx, spec.detector, spec.path, "on a different file system than its root");
    return false;
  }
  const tree = await analyzeTree(deps.fs, spec.path, st, { dev: st.dev, maxEntries: config.maxEntriesPerCandidate, strict: spec.strict });
  if (!tree.ok) {
    skip(ctx, spec.detector, spec.path, tree.reason);
    return false;
  }
  const { size, entries, newestMtimeMs } = tree.stats;
  if (size < config.minSizeBytes) {
    skip(ctx, spec.detector, spec.path, `below the minimum size of ${config.minSizeBytes} bytes`);
    return false;
  }
  const now = deps.now();
  const activity = Math.max(spec.activityMs, newestMtimeMs, Number(st.mtimeMs));
  const ageMs = now - activity;
  if (ageMs < spec.minAgeDays * DAY_MS) {
    skip(ctx, spec.detector, spec.path, `activity ${Math.max(0, Math.floor(ageMs / DAY_MS))} days ago, minimum age is ${spec.minAgeDays} days`);
    return false;
  }
  const open = openPathUnder(ctx.open, spec.path);
  if (open) {
    skip(ctx, spec.detector, spec.path, "a process has files open inside it");
    return false;
  }
  const ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));
  ctx.candidates.push({
    kind: "fs",
    detector: spec.detector,
    path: spec.path,
    type: "dir",
    dev: st.dev.toString(),
    ino: st.ino.toString(),
    size,
    entries,
    mtimeMs: Number(st.mtimeMs),
    newestMtimeMs,
    ageDays,
    reason: spec.reasonFor(ageDays),
    regenerate: spec.regenerate,
  });
  return true;
}
