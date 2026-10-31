// A complete in-memory world for the disposal use cases: file system, clock, ids, key, audit
// trail, approvals, lock, quarantine store, open files and docker, plus helpers to plan, approve
// and apply. Everything is deterministic.
import { applyPlan, type ApplyPorts, type ApplyResult } from "../../src/application/apply-plan.js";
import { issueApproval } from "../../src/application/approvals.js";
import { inspectTree } from "../../src/application/inspect-tree.js";
import type { ApplyHooks, FileSystem } from "../../src/application/ports/common.js";
import type { Config } from "../../src/domain/model/config.js";
import type { Plan } from "../../src/domain/model/types.js";
import { buildPlan, type PlanInput } from "../../src/domain/plan/plan.js";
import { dockerInput, fsInput, HOME, makeConfig, ROOT, STATE_DIR } from "./builders.js";
import { FakeClock, FakeIds } from "./fakes/clock.js";
import { FakeDocker } from "./fakes/docker.js";
import { MemoryFileSystem } from "./fakes/memory-fs.js";
import { MemoryApprovalStore, MemoryApplyLock, MemoryAuditTrail, MemoryKeyStore, type KeyVault, type LockState } from "./fakes/memory-stores.js";
import { MemoryQuarantineStore } from "./fakes/memory-quarantine.js";
import { FakeOpenFiles } from "./fakes/open-files.js";

export { HOME, ROOT };
export const QUARANTINE_ROOT = `${STATE_DIR}/quarantine`;

/** A FileSystem that delegates to `fs` except for the given overrides (failure injection). */
export function wrapFs(fs: FileSystem, over: Partial<FileSystem>): FileSystem {
  return {
    lstat: (p) => fs.lstat(p),
    readdir: (p) => fs.readdir(p),
    realpath: (p) => fs.realpath(p),
    rename: (a, b) => fs.rename(a, b),
    ...over,
  };
}

export function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

export class DisposalWorld {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly fs = new MemoryFileSystem().mkdir(ROOT).mkdir(HOME).mkdir(QUARANTINE_ROOT);
  readonly vault: KeyVault = { key: null };
  readonly keys = new MemoryKeyStore(this.vault);
  readonly audit = new MemoryAuditTrail(() => this.clock.now());
  readonly approvals = new MemoryApprovalStore();
  readonly lockState: LockState = { holder: null };
  readonly lock = new MemoryApplyLock(this.lockState);
  readonly quarantine = new MemoryQuarantineStore(this.fs, QUARANTINE_ROOT, this.keys);
  readonly openFiles = new FakeOpenFiles([]);
  readonly docker = new FakeDocker();
  readonly hooks: ApplyHooks = {};
  config: Config = makeConfig();

  /** `<root>/<name>/node_modules/dep/index.js`; returns the node_modules path. */
  project(name: string, bytes = 4096): string {
    this.fs.writeFile(`${ROOT}/${name}/package.json`);
    this.fs.writeFile(`${ROOT}/${name}/node_modules/dep/index.js`, { bytes });
    return `${ROOT}/${name}/node_modules`;
  }

  /** Measure a directory the way discovery does and describe it as a Candidate. */
  async measure(path: string, over: Parameters<typeof fsInput>[1] = {}): Promise<PlanInput["fs"][number]> {
    const st = await this.fs.lstat(path);
    const tree = await inspectTree(this.fs, path, st, { dev: st.dev, maxEntries: 1_000_000, strict: false });
    if (!tree.ok) throw new Error(`cannot measure ${path}: ${tree.reason}`);
    return fsInput(path, {
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      size: tree.stats.size,
      entries: tree.stats.entries,
      mtimeMs: Number(st.mtimeMs),
      newestMtimeMs: tree.stats.newestMtimeMs,
      ...over,
    });
  }

  /** A Plan (made at the current time) for the given directories, then docker resources. */
  async plan(paths: string[], docker: Array<"build-cache" | "dangling-images"> = [], config: Config = this.config): Promise<Plan> {
    const found = { fs: await Promise.all(paths.map((p) => this.measure(p))), docker: docker.map((r) => dockerInput(r)), reports: [] };
    return buildPlan(config, found, this.clock.now(), this.ids.hex(4));
  }

  async approve(plan: Plan, validityMs?: number): Promise<void> {
    await issueApproval({ clock: this.clock, ids: this.ids, keys: this.keys, approvals: this.approvals }, plan, validityMs);
  }

  ports(over: Partial<ApplyPorts> = {}): ApplyPorts {
    return {
      clock: this.clock,
      fs: this.fs,
      lock: this.lock,
      keys: this.keys,
      approvals: this.approvals,
      audit: this.audit,
      quarantine: this.quarantine,
      openFiles: this.openFiles,
      docker: this.docker,
      hooks: this.hooks,
      ...over,
    };
  }

  /** Ports for restore and purge. */
  disposalPorts(fs: FileSystem = this.fs) {
    return { fs, clock: this.clock, quarantine: this.quarantine, events: this.audit };
  }

  apply(plan: Plan, over: Partial<ApplyPorts> = {}, config: Config = this.config): Promise<ApplyResult> {
    return applyPlan(this.ports(over), config, plan);
  }

  /** Plan, approve and apply the given directories. */
  async applied(paths: string[]): Promise<{ plan: Plan; result: ApplyResult }> {
    const plan = await this.plan(paths);
    await this.approve(plan);
    return { plan, result: await this.apply(plan) };
  }

  /** Names of the audit events logged so far. */
  async eventNames(): Promise<string[]> {
    return (await this.audit.logged()).map((e) => e.name);
  }

  async events(): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
    return this.audit.logged();
  }

  itemPath(plan: Plan, index: number): string {
    return this.quarantine.itemPath(plan.id, String(index).padStart(4, "0"));
  }
}
