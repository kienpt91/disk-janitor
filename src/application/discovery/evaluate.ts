import { assessFsCandidate, directoryRefusal, type CandidateRule, type DirectoryFacts, type PathKind } from "../../domain/discovery/eligibility.js";
import { inspectTree } from "../inspect-tree.js";
import type { FileStat } from "../ports/common.js";
import type { DiscoveryRun } from "./context.js";

export function pathKind(st: FileStat | null): PathKind {
  if (!st) return "missing";
  if (st.isSymbolicLink()) return "symlink";
  return st.isDirectory() ? "directory" : "other";
}

export function directoryFacts(st: FileStat | null): DirectoryFacts {
  return { kind: pathKind(st), dev: st?.dev ?? 0n, ino: st?.ino ?? 0n, mtimeMs: st ? Number(st.mtimeMs) : 0 };
}

export interface EvaluateSpec {
  rule: CandidateRule;
  path: string;
  /** Device of the root (or home, for caches) the candidate must stay on. */
  baseDev: bigint;
  /** Latest known activity, ms. The newest mtime inside the candidate is folded in. */
  activityMs: number;
}

/** Shared checks for every file system candidate. Returns true when it was accepted. */
export async function evaluateFsCandidate(run: DiscoveryRun, spec: EvaluateSpec): Promise<boolean> {
  const { ports, config, findings } = run;
  const { rule, path } = spec;
  let st: FileStat | null = null;
  try {
    st = await ports.fs.lstat(path);
  } catch {
    st = null;
  }
  const directory = directoryFacts(st);
  const refusal = directoryRefusal(path, directory, { homes: run.homes, baseDev: spec.baseDev });
  if (refusal || !st) {
    findings.skip(rule.detector, path, refusal ?? "cannot stat");
    return false;
  }
  const tree = await inspectTree(ports.fs, path, st, { dev: st.dev, maxEntries: config.maxEntriesPerCandidate, strict: rule.strict });
  if (!tree.ok) {
    findings.skip(rule.detector, path, tree.reason);
    return false;
  }
  const verdict = assessFsCandidate({
    rule,
    path,
    directory,
    tree: tree.stats,
    minSizeBytes: config.minSizeBytes,
    nowMs: ports.clock.now(),
    activityMs: spec.activityMs,
    openFiles: run.open,
  });
  if (!verdict.ok) {
    findings.skip(rule.detector, path, verdict.reason);
    return false;
  }
  findings.accept(verdict.value);
  return true;
}
