// ApplyPlan: apply an approved Plan. Verify the Approval, re-validate every Candidate, then move
// them into Quarantine with rename (never copy+delete, never unlink). Any change since planning
// aborts the whole Apply before the first move; a failure part-way rolls the earlier moves back.
// Docker Candidates run last, through fixed docker commands. Every step is published as a domain
// event, which the audit adapter appends to the hash-chained log.

import { ApplyRun } from "../domain/apply/apply-run.js";
import type { CatalogExpectation, CatalogFacts } from "../domain/discovery/catalog-match.js";
import { quickRecheckProblem, Revalidation, swappedBeforeRename, type ChainFact, type ObservedNode } from "../domain/apply/revalidation.js";
import { LockHeldError } from "../domain/errors.js";
import { events, type DomainEvent } from "../domain/events.js";
import type { Config } from "../domain/model/config.js";
import type { DockerCandidate, FsCandidate, Plan } from "../domain/model/types.js";
import { openPathUnder, type OpenFileIndex } from "../domain/discovery/facts.js";
import { isPlanTooOld } from "../domain/plan/plan.js";
import { join } from "node:path";
import { Manifest } from "../domain/quarantine/manifest.js";
import { consumeApproval, verifyApproval } from "./approvals.js";
import { inspectTree } from "./inspect-tree.js";
import { findSymlinkInChain, lstatOrNull } from "./inspection.js";
import type { ApplyHooks, ApplyLock, Clock, FileStat, FileSystem } from "./ports/common.js";
import type { DockerPort, OpenFilesPort } from "./ports/discovery.js";
import type { ApprovalStore, AuditTrail, KeyStore } from "./ports/planning.js";
import type { QuarantineStore } from "./ports/quarantine.js";

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

export interface ApplyPorts {
  clock: Clock;
  fs: FileSystem;
  lock: ApplyLock;
  keys: KeyStore;
  approvals: ApprovalStore;
  /** Verifies the hash chain; also the publisher of every event. */
  audit: AuditTrail;
  quarantine: QuarantineStore;
  openFiles: OpenFilesPort;
  docker: DockerPort;
  hooks?: ApplyHooks | undefined;
}

const toNode = (st: FileStat): ObservedNode => ({
  dev: st.dev,
  ino: st.ino,
  isDirectory: st.isDirectory(),
  isSymbolicLink: st.isSymbolicLink(),
  mtimeMs: Number(st.mtimeMs),
});

async function nodeOrNull(fs: FileSystem, path: string): Promise<ObservedNode | null> {
  try {
    return toNode(await fs.lstat(path));
  } catch {
    return null;
  }
}

async function chainFact(fs: FileSystem, path: string): Promise<ChainFact> {
  try {
    return (await findSymlinkInChain(fs, path, true)) ? { kind: "link" } : { kind: "clean" };
  } catch (e) {
    return { kind: "unreadable", code: (e as NodeJS.ErrnoException).code ?? "error" };
  }
}

/** Look (lstat only) at the project directory of a Candidate for what its catalogue entry needs. */
async function observeCatalog(fs: FileSystem, need: Exclude<CatalogExpectation, { kind: "refused" }>): Promise<CatalogFacts> {
  const facts = { regularFiles: new Set<string>(), pythonSource: false, gitEntry: false };
  if (need.kind === "exact") return facts;
  for (const name of need.files) {
    const st = await lstatOrNull(fs, join(need.projectDir, name)).catch(() => null);
    if (st?.isFile()) facts.regularFiles.add(name);
  }
  if (need.kind === "build-output") {
    if (need.pythonSource) {
      const names = await fs.readdir(need.projectDir).catch(() => [] as string[]);
      for (const n of names.filter((x) => x.endsWith(".py"))) {
        if ((await lstatOrNull(fs, join(need.projectDir, n)).catch(() => null))?.isFile()) {
          facts.pythonSource = true;
          break;
        }
      }
    }
    for (const dir of need.gitDirs) {
      if (await lstatOrNull(fs, join(dir, ".git")).catch(() => null)) {
        facts.gitEntry = true;
        break;
      }
    }
  }
  return facts;
}

/**
 * Re-validate every file-system Candidate against the Plan. Returns the problems found (empty
 * means every Candidate is exactly as planned). Nothing is modified.
 */
export async function revalidate(
  ports: Pick<ApplyPorts, "fs" | "openFiles">,
  config: Config,
  plan: Plan,
  itemsDevice: bigint,
): Promise<string[]> {
  const fsCandidates = plan.candidates.filter((c): c is FsCandidate => c.kind === "fs");
  const run = new Revalidation({ config, planCreatedAt: plan.createdAt, itemsDevice }, fsCandidates);
  const open: OpenFileIndex = fsCandidates.length > 0 ? await ports.openFiles.snapshot() : { available: false, names: [] };

  for (let i = 0; i < fsCandidates.length; i++) {
    const check = run.candidate(i);
    const c = check.planned;
    check.overlap();
    if (!check.location()) continue;
    if (!check.chain(await chainFact(ports.fs, c.path))) continue;
    let st: FileStat | null = null;
    let baseSt: FileStat | null = null;
    try {
      st = await ports.fs.lstat(c.path);
      baseSt = await ports.fs.lstat(check.baseDir);
    } catch {
      st = null;
    }
    if (!check.node(st && toNode(st), baseSt && toNode(baseSt))) continue;
    const need = check.catalogNeed();
    if (!need || !check.catalogFacts(need, await observeCatalog(ports.fs, need))) continue;
    const dir = st as FileStat;
    const tree = await inspectTree(ports.fs, c.path, dir, { dev: dir.dev, maxEntries: config.maxEntriesPerCandidate, strict: c.detector === "build-output" });
    const observed = tree.ok ? { ok: true as const, size: tree.stats.size, entries: tree.stats.entries, newestMtimeMs: tree.stats.newestMtimeMs } : tree;
    if (!check.tree(observed)) continue;
    check.open(open.available ? openPathUnder(open, c.path) : null);
  }
  return [...run.problems];
}

/**
 * Apply an approved plan. Throws ApplyError (config-mismatch, plan-too-old, locked, audit,
 * not-approved, validation, io); nothing is modified on a validation failure.
 */
export async function applyPlan(ports: ApplyPorts, config: Config, plan: Plan): Promise<ApplyResult> {
  const publish = (e: DomainEvent) => ports.audit.publish(e);
  if (config.digest !== plan.configDigest) {
    throw new ApplyError("config-mismatch", "the active configuration differs from the one the plan was made with; re-run plan");
  }
  if (isPlanTooOld(plan, ports.clock.now())) {
    throw new ApplyError("plan-too-old", "the plan is older than 24 hours; re-run plan");
  }
  let lease;
  try {
    lease = await ports.lock.acquire();
  } catch (e) {
    if (e instanceof LockHeldError) throw new ApplyError("locked", e.message);
    throw e;
  }
  try {
    const v = await ports.audit.verify();
    if (!v.ok) {
      throw new ApplyError("audit", `audit log is corrupt at line ${v.line} (${v.reason}); move audit.jsonl aside after reviewing it`);
    }
    const approval = await verifyApproval(ports, plan);
    if (!approval.ok) {
      await publish(events.applyRefused({ planId: plan.id, planDigest: plan.digest, reason: approval.reason }));
      throw new ApplyError("not-approved", `apply refused: ${approval.reason}. A human must run 'disk-janitor approve ${plan.id}' in a terminal`);
    }
    await consumeApproval({ approvals: ports.approvals, events: ports.audit }, approval.record);
    const fsCandidates = plan.candidates.filter((c): c is FsCandidate => c.kind === "fs");
    const dockerCandidates = plan.candidates.filter((c): c is DockerCandidate => c.kind === "docker");
    await publish(events.applyStarted({ planId: plan.id, planDigest: plan.digest, fs: fsCandidates.length }));
    if (dockerCandidates.length > 0 && !config.dockerApply) {
      await publish(events.applyAborted({ planId: plan.id, reason: "docker candidates present but docker apply is not enabled" }));
      throw new ApplyError("validation", "the plan contains docker candidates but docker apply is not enabled in the configuration");
    }

    const result: ApplyResult = { planId: plan.id, quarantineDir: ports.quarantine.planDir(plan.id), moved: [], docker: [] };

    if (fsCandidates.length > 0) {
      try {
        await ports.quarantine.create(plan.id);
      } catch (e) {
        throw new ApplyError("io", `cannot create the quarantine for this plan (already applied?): ${(e as NodeJS.ErrnoException).code ?? "error"}`);
      }
      const itemsDevice = (await ports.fs.lstat(ports.quarantine.itemsDir(plan.id))).dev;
      const problems = await revalidate(ports, config, plan, itemsDevice);
      if (problems.length > 0) {
        await publish(events.applyAborted({ planId: plan.id, reason: "validation failed", problems }));
        await ports.quarantine.discard(plan.id);
        throw new ApplyError("validation", "aborted: the file system no longer matches the plan; nothing was changed", problems);
      }
      await ports.hooks?.afterValidate?.();
      await quarantineAll(ports, config, plan, fsCandidates, result);
    }

    for (const c of dockerCandidates) {
      await publish(events.dockerPruneBegan({ planId: plan.id, resource: c.resource }));
      const outcome = await ports.docker.prune(c.resource);
      await publish(events.dockerPruneDone({ planId: plan.id, resource: c.resource, ok: outcome.ok, detail: outcome.detail }));
      result.docker.push({ id: c.id, resource: c.resource, ok: outcome.ok, detail: outcome.detail });
    }
    await publish(events.applyCompleted({ planId: plan.id, moved: result.moved.length, docker: result.docker.length }));
    return result;
  } finally {
    await lease.release();
  }
}

async function quarantineAll(ports: ApplyPorts, config: Config, plan: Plan, fsCandidates: FsCandidate[], result: ApplyResult): Promise<void> {
  const publish = (e: DomainEvent) => ports.audit.publish(e);
  const manifest = Manifest.create({
    planId: plan.id,
    planDigest: plan.digest,
    createdAt: ports.clock.now(),
    roots: config.roots,
    home: config.home,
    detectors: config.detectors,
    candidates: fsCandidates,
  });
  const run = ApplyRun.begin(plan, manifest, fsCandidates);
  await ports.quarantine.save(run.manifest);

  const rollback = async () => {
    for (const c of run.pendingRollback()) {
      let putBack = true;
      try {
        await ports.fs.rename(ports.quarantine.itemPath(plan.id, run.storedNameOf(c)), c.path);
      } catch {
        putBack = false;
      }
      await publish(putBack ? run.rolledBack(c, ports.clock.now()) : run.rollbackFailed(c)).catch(() => undefined);
    }
    await ports.quarantine.save(run.manifest).catch(() => undefined);
  };

  for (let c = run.next; c; c = run.next) {
    const dest = ports.quarantine.itemPath(plan.id, run.storedNameOf(c));
    const chain = await chainFact(ports.fs, c.path);
    const why = quickRecheckProblem(c, chain, chain.kind === "clean" ? await nodeOrNull(ports.fs, c.path) : null);
    if (why) {
      await publish(run.abort({ kind: "recheck", path: c.path, why }));
      await rollback();
      throw new ApplyError("validation", `aborted before moving ${c.path}: ${why}`, [`${c.id} ${c.path}: ${why}`]);
    }
    await publish(run.beginMove(c));
    await ports.hooks?.beforeRename?.(c.path);
    try {
      await ports.fs.rename(c.path, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      await publish(run.abort({ kind: "rename-failed", path: c.path, code }));
      await rollback();
      throw new ApplyError("io", `aborted: could not move ${c.path} (${code}); earlier moves were rolled back`);
    }
    // What arrived in quarantine must be exactly what was planned (catches a swap that won the race).
    if (swappedBeforeRename(c, await nodeOrNull(ports.fs, dest))) {
      let undone = false;
      try {
        await ports.fs.rename(dest, c.path);
        undone = true;
      } catch {
        undone = false;
      }
      await publish(run.abort({ kind: "swapped", path: c.path, undone }));
      await rollback();
      throw new ApplyError("validation", `aborted: ${c.path} changed between validation and rename; it was ${undone ? "put back" : "NOT put back (see quarantine)"}`);
    }
    const done = run.confirmMoved(c, ports.clock.now());
    await ports.quarantine.save(run.manifest);
    await publish(done);
    result.moved.push({ id: c.id, path: c.path, size: c.size });
  }
  run.complete();
}
