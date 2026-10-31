import { lstat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { analyzeTree } from "./analyze.js";
import { consumeApproval, verifyApproval } from "./approval.js";
import { AuditLog } from "./audit.js";
import { baseFor } from "./bases.js";
import type { Config } from "./domain/model/config.js";
import type { Deps } from "./composition/deps.js";
import { runDockerPrune } from "./detectors/docker.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { loadOpenFiles, openPathUnder } from "./openfiles.js";
import { isCanonicalAbsolute, isInside } from "./domain/shared/paths.js";
import { findSymlinkInChain } from "./application/inspection.js";
import { protectedReason } from "./domain/policy/protected.js";
import {
  ensureQuarantineDirs,
  itemPath,
  planQuarantineDir,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from "./quarantine.js";
import type { State } from "./state.js";
import { DAY_MS, type DockerCandidate, type FsCandidate, type Plan } from "./domain/model/types.js";

export const MAX_PLAN_AGE_MS = DAY_MS;

export type ApplyFailure = "config-mismatch" | "plan-too-old" | "locked" | "audit" | "not-approved" | "validation" | "io";

export class ApplyError extends Error {
  constructor(
    public readonly code: ApplyFailure,
    message: string,
    public readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ApplyError";
  }
}

export interface ApplyResult {
  planId: string;
  quarantineDir: string;
  moved: Array<{ id: string; path: string; size: number }>;
  docker: Array<{ id: string; resource: DockerCandidate["resource"]; ok: boolean; detail: string }>;
}

export interface ApplyInput {
  config: Config;
  state: State;
  plan: Plan;
  deps: Deps;
}

const MAX_PROBLEMS = 50;

/**
 * Re-validate every file-system candidate against the plan. Returns the problems found (empty
 * means every candidate is exactly as planned). Nothing is modified.
 */
export async function revalidate(input: ApplyInput, itemsDevice: bigint): Promise<string[]> {
  const { config, plan, deps } = input;
  const problems: string[] = [];
  const add = (c: FsCandidate, why: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(`${c.id} ${c.path}: ${why}`);
  };
  const fsCandidates = plan.candidates.filter((c): c is FsCandidate => c.kind === "fs");
  const open = fsCandidates.length > 0 ? await loadOpenFiles(deps.run) : { available: false, names: [] };

  for (let i = 0; i < fsCandidates.length; i++) {
    const c = fsCandidates[i] as FsCandidate;
    for (let j = 0; j < fsCandidates.length; j++) {
      if (i !== j && isInside(c.path, (fsCandidates[j] as FsCandidate).path)) add(c, "contains another candidate");
    }
    if (!isCanonicalAbsolute(c.path)) {
      add(c, "path is not canonical");
      continue;
    }
    const base = baseFor(config, c.path);
    if (!base) {
      add(c, "outside the configured roots");
      continue;
    }
    const prot = protectedReason(c.path, [config.home]);
    if (prot) {
      add(c, prot);
      continue;
    }
    let link: string | null;
    try {
      link = await findSymlinkInChain(deps.fs, c.path, true);
    } catch (e) {
      add(c, `cannot inspect the path (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      continue;
    }
    if (link) {
      add(c, "a symlink or non-directory appeared in the path");
      continue;
    }
    let st;
    let baseSt;
    try {
      st = await deps.fs.lstat(c.path);
      baseSt = await deps.fs.lstat(base.dir);
    } catch {
      add(c, "path or its root disappeared");
      continue;
    }
    if (!baseSt.isDirectory() || baseSt.isSymbolicLink()) {
      add(c, "its root is not a real directory any more");
      continue;
    }
    if (st.isSymbolicLink()) {
      add(c, "is now a symlink");
      continue;
    }
    if (!st.isDirectory()) {
      add(c, "is no longer a directory");
      continue;
    }
    if (st.dev.toString() !== c.dev || st.ino.toString() !== c.ino) {
      add(c, "device or inode changed since the plan was made");
      continue;
    }
    if (st.dev !== baseSt.dev) {
      add(c, "is on a different file system than its root");
      continue;
    }
    if (st.dev !== itemsDevice) {
      add(c, "is on a different file system than the quarantine; rename cannot cross devices and copying is never done");
      continue;
    }
    if (Number(st.mtimeMs) !== c.mtimeMs || Number(st.mtimeMs) > plan.createdAt) {
      add(c, "directory was modified after the plan was made");
      continue;
    }
    const tree = await analyzeTree(deps.fs, c.path, st, { dev: st.dev, maxEntries: config.maxEntriesPerCandidate, strict: c.detector === "build-output" });
    if (!tree.ok) {
      add(c, tree.reason);
      continue;
    }
    if (tree.stats.size !== c.size || tree.stats.entries !== c.entries || tree.stats.newestMtimeMs !== c.newestMtimeMs) {
      add(c, "contents changed since the plan was made");
      continue;
    }
    if (tree.stats.newestMtimeMs > plan.createdAt) {
      add(c, "contents are newer than the plan");
      continue;
    }
    if (open.available) {
      const o = openPathUnder(open, c.path);
      if (o) add(c, "a process has files open inside it");
    }
  }
  return problems;
}

async function quickRecheck(deps: Deps, c: FsCandidate): Promise<string | null> {
  try {
    const link = await findSymlinkInChain(deps.fs, c.path, true);
    if (link) return "a symlink or non-directory appeared in the path";
    const st = await deps.fs.lstat(c.path);
    if (st.isSymbolicLink() || !st.isDirectory()) return "is no longer a real directory";
    if (st.dev.toString() !== c.dev || st.ino.toString() !== c.ino) return "device or inode changed";
  } catch {
    return "path disappeared";
  }
  return null;
}

/**
 * Apply an approved plan: verify the approval, re-validate everything, then move candidates into
 * quarantine with rename (never copy+delete, never unlink). Any change since planning aborts the
 * whole apply before the first move. Docker candidates run last, through fixed docker commands.
 */
export async function applyPlan(input: ApplyInput): Promise<ApplyResult> {
  const { config, state, plan, deps } = input;
  const audit = new AuditLog(state, deps.now);
  if (config.digest !== plan.configDigest) {
    throw new ApplyError("config-mismatch", "the active configuration differs from the one the plan was made with; re-run plan");
  }
  if (deps.now() - plan.createdAt > MAX_PLAN_AGE_MS) {
    throw new ApplyError("plan-too-old", "the plan is older than 24 hours; re-run plan");
  }
  let lock;
  try {
    lock = await acquireLock(state.lockPath, { timeoutMs: 0 });
  } catch (e) {
    if (e instanceof LockHeldError) throw new ApplyError("locked", e.message);
    throw e;
  }
  try {
    const v = await audit.verify();
    if (!v.ok) {
      throw new ApplyError("audit", `audit log is corrupt at line ${v.line} (${v.reason}); move audit.jsonl aside after reviewing it`);
    }
    const approval = await verifyApproval(state, plan, deps.now(), audit);
    if (!approval.ok) {
      await audit.append("apply-refused", { planId: plan.id, planDigest: plan.digest, reason: approval.reason });
      throw new ApplyError("not-approved", `apply refused: ${approval.reason}. A human must run 'disk-janitor approve ${plan.id}' in a terminal`);
    }
    await consumeApproval(state, approval.record, audit);
    await audit.append("apply-start", { planId: plan.id, planDigest: plan.digest, fs: plan.candidates.filter((c) => c.kind === "fs").length });

    const fsCandidates = plan.candidates.filter((c): c is FsCandidate => c.kind === "fs");
    const dockerCandidates = plan.candidates.filter((c): c is DockerCandidate => c.kind === "docker");
    if (dockerCandidates.length > 0 && !config.dockerApply) {
      await audit.append("apply-aborted", { planId: plan.id, reason: "docker candidates present but docker apply is not enabled" });
      throw new ApplyError("validation", "the plan contains docker candidates but docker apply is not enabled in the configuration");
    }

    const result: ApplyResult = { planId: plan.id, quarantineDir: planQuarantineDir(state, plan.id), moved: [], docker: [] };

    if (fsCandidates.length > 0) {
      try {
        await ensureQuarantineDirs(state, plan.id);
      } catch (e) {
        throw new ApplyError("io", `cannot create the quarantine for this plan (already applied?): ${(e as NodeJS.ErrnoException).code ?? "error"}`);
      }
      const itemsDev = (await deps.fs.lstat(join(result.quarantineDir, "items"))).dev;
      const problems = await revalidate(input, itemsDev);
      if (problems.length > 0) {
        await audit.append("apply-aborted", { planId: plan.id, reason: "validation failed", problems });
        await rmdir(join(result.quarantineDir, "items")).catch(() => undefined);
        await rmdir(result.quarantineDir).catch(() => undefined);
        throw new ApplyError("validation", "aborted: the file system no longer matches the plan; nothing was changed", problems);
      }
      await deps.hooks?.afterValidate?.();
      await quarantineAll(input, audit, fsCandidates, result);
    }

    for (const c of dockerCandidates) {
      await audit.append("docker-prune-begin", { planId: plan.id, resource: c.resource });
      const res = await runDockerPrune(deps.run, c.resource);
      const ok = res.code === 0;
      const detail = (ok ? res.stdout : res.stderr || res.error || "failed").slice(-400);
      await audit.append("docker-prune-done", { planId: plan.id, resource: c.resource, ok, detail });
      result.docker.push({ id: c.id, resource: c.resource, ok, detail });
    }
    await audit.append("apply-complete", { planId: plan.id, moved: result.moved.length, docker: result.docker.length });
    return result;
  } finally {
    await lock.release();
  }
}

async function quarantineAll(input: ApplyInput, audit: AuditLog, fsCandidates: FsCandidate[], result: ApplyResult): Promise<void> {
  const { config, state, plan, deps } = input;
  const entries: ManifestEntry[] = fsCandidates.map((c, i) => ({
    index: i + 1,
    stored: String(i + 1).padStart(4, "0"),
    originalPath: c.path,
    detector: c.detector,
    dev: c.dev,
    ino: c.ino,
    size: c.size,
    mtimeMs: c.mtimeMs,
    status: "pending" as const,
  }));
  const manifest: Omit<Manifest, "mac"> = {
    version: 1,
    planId: plan.id,
    planDigest: plan.digest,
    createdAt: deps.now(),
    roots: config.roots,
    home: config.home,
    detectors: config.detectors,
    entries,
  };
  await writeManifest(state, manifest);
  const moved: Array<{ c: FsCandidate; entry: ManifestEntry }> = [];

  const rollback = async () => {
    for (const m of [...moved].reverse()) {
      try {
        await deps.fs.rename(itemPath(state, plan.id, m.entry.stored), m.c.path);
        m.entry.status = "restored";
        m.entry.restoredAt = deps.now();
        await audit.append("rollback", { planId: plan.id, path: m.c.path });
      } catch {
        await audit.append("rollback-failed", { planId: plan.id, path: m.c.path }).catch(() => undefined);
      }
    }
    await writeManifest(state, { ...manifest, entries }).catch(() => undefined);
  };

  for (let i = 0; i < fsCandidates.length; i++) {
    const c = fsCandidates[i] as FsCandidate;
    const entry = entries[i] as ManifestEntry;
    const dest = itemPath(state, plan.id, entry.stored);
    const why = await quickRecheck(deps, c);
    if (why) {
      await audit.append("apply-aborted", { planId: plan.id, path: c.path, reason: why });
      await rollback();
      throw new ApplyError("validation", `aborted before moving ${c.path}: ${why}`, [`${c.id} ${c.path}: ${why}`]);
    }
    await audit.append("quarantine-begin", { planId: plan.id, id: c.id, path: c.path, size: c.size });
    await deps.hooks?.beforeRename?.(c.path);
    try {
      await deps.fs.rename(c.path, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      await audit.append("apply-aborted", { planId: plan.id, path: c.path, reason: `rename failed (${code})` });
      await rollback();
      throw new ApplyError("io", `aborted: could not move ${c.path} (${code}); earlier moves were rolled back`);
    }
    // What arrived in quarantine must be exactly what was planned (catches a swap that won the race).
    let landed;
    try {
      landed = await lstat(dest, { bigint: true });
    } catch {
      landed = null;
    }
    if (!landed || landed.isSymbolicLink() || !landed.isDirectory() || landed.dev.toString() !== c.dev || landed.ino.toString() !== c.ino) {
      let undone = false;
      try {
        await deps.fs.rename(dest, c.path);
        undone = true;
      } catch {
        undone = false;
      }
      await audit.append("apply-aborted", { planId: plan.id, path: c.path, reason: "item changed between validation and rename", undone });
      await rollback();
      throw new ApplyError("validation", `aborted: ${c.path} changed between validation and rename; it was ${undone ? "put back" : "NOT put back (see quarantine)"}`);
    }
    entry.status = "quarantined";
    entry.quarantinedAt = deps.now();
    moved.push({ c, entry });
    await writeManifest(state, { ...manifest, entries });
    await audit.append("quarantine-done", { planId: plan.id, id: c.id, path: c.path, size: c.size });
    result.moved.push({ id: c.id, path: c.path, size: c.size });
  }
}
