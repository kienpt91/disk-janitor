import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { lstat, mkdtemp, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { arch, homedir, platform } from "node:os";
import { applyPlan, ApplyError } from "../../composition/disposal.js";
import { approvePlan } from "../../application/approvals.js";
import { planningPorts } from "../../composition/planning.js";
import { DEFAULT_VALIDITY_MS, MAX_VALIDITY_MS } from "../../domain/approval/approval.js";
import { AuditLog } from "../state/audit-log.js";
import { defaultStateDir, type RawConfig } from "../../domain/model/config.js";
import { loadConfigFile } from "../config-file.js";
import { resolveConfig } from "../../composition/planning.js";
import { defaultDeps, type Deps } from "../../composition/deps.js";
import { escapeText, safeJson } from "../../domain/shared/escape.js";
import { describeReport, formatBytes, formatTime, renderPlanSummary, renderScan, describeCandidate } from "./format.js";
import { assertHumanSession, digestPrefix, HumanRequiredError } from "../../domain/policy/human.js";
import { confirmByTyping, type HumanIO } from "../../application/human-confirmation.js";
import { createPlan, loadPlan, openStateFor } from "../../composition/planning.js";
import { MAX_PLAN_AGE_MS } from "../../domain/plan/plan.js";
import { PlanIntegrityError, PlanTooOldError } from "../../domain/plan/plan.js";
import { DEFAULT_PURGE_TTL_DAYS, listQuarantine, previewRestore, purgeCandidates, purgeItems, purgeSetDigest, restore } from "../../composition/disposal.js";
import { scan } from "../../composition/discovery.js";
import { openState, StateError } from "../state/state-dir.js";
import { loadKey } from "../state/key-store.js";
import { DAY_MS } from "../../domain/model/types.js";
import { RootsError } from "../../domain/policy/roots.js";
import { LockHeldError } from "../../domain/errors.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  ask(question: string): Promise<string>;
}

const HELP = `disk-janitor: disk cleanup that coding agents can use safely

usage: disk-janitor <command> [options]

commands:
  scan                  read-only: list reclaimable candidates
  plan                  scan and write a plan file (does not change anything)
  explain <plan>        show a plan in detail and verify its digest
  approve <plan>        HUMAN ONLY (interactive terminal): approve a plan for 15 minutes
  apply <plan>          move an approved plan's candidates into quarantine
  restore <planId|path> move quarantined items back to where they came from
  purge                 HUMAN ONLY: permanently delete quarantined items older than the TTL
  status                show state directory, quarantine and audit status
  audit                 print the hash-chained audit log
  doctor                check permissions and file system support

options:
  --root <dir>          directory to scan (repeatable; there is no default)
  --config <file>       JSON config file (flags override it)
  --state-dir <dir>     state directory (default: $XDG_STATE_HOME or ~/.local/state/disk-janitor)
  --home <dir>          home directory for protected paths and package caches
  --caches              also report/plan package-manager caches below the home directory
  --docker-apply        allow docker build-cache and dangling-image pruning (after approval)
  --detectors <list>    comma-separated detectors (node-modules,build-output,package-cache,docker,git-worktrees)
  --stale-days <n>      days a project must be untouched before its node_modules is offered (30)
  --build-min-age-days <n>, --cache-min-age-days <n>, --min-size <bytes>
  --out <file>          write the plan here instead of the state directory
  --minutes <n>         approval validity in minutes (default 15, max 60)
  --ttl-days <n>        purge only items quarantined at least this long (default 7)
  --dry-run             purge: list what would be deleted
  --json                machine-readable output (scan, status)
  --verbose             list skipped paths with reasons
  -h, --help            this help
`;

const OPTIONS = {
  root: { type: "string", multiple: true },
  config: { type: "string" },
  "state-dir": { type: "string" },
  home: { type: "string" },
  caches: { type: "boolean" },
  "docker-apply": { type: "boolean" },
  detectors: { type: "string" },
  "stale-days": { type: "string" },
  "build-min-age-days": { type: "string" },
  "cache-min-age-days": { type: "string" },
  "min-size": { type: "string" },
  out: { type: "string" },
  minutes: { type: "string" },
  "ttl-days": { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>["values"];

function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^[0-9]{1,12}$/.test(v)) throw new UsageError(`--${name} expects a non-negative integer`);
  return Number(v);
}

export class UsageError extends Error {}

async function rawConfigFrom(values: Values, cwd: string): Promise<RawConfig> {
  const file: RawConfig = values.config ? await loadConfigFile(resolve(cwd, values.config)) : {};
  const raw: RawConfig = { ...file };
  if (values.root && values.root.length > 0) raw.roots = values.root;
  if (values["state-dir"]) raw.stateDir = values["state-dir"];
  if (values.home) raw.home = values.home;
  if (values.caches) raw.packageCaches = true;
  if (values["docker-apply"]) raw.dockerApply = true;
  if (values.detectors) {
    raw.detectors = values.detectors.split(",").map((s) => s.trim()) as NonNullable<RawConfig["detectors"]>;
  }
  const sd = num("stale-days", values["stale-days"]);
  if (sd !== undefined) raw.staleDays = sd;
  const bd = num("build-min-age-days", values["build-min-age-days"]);
  if (bd !== undefined) raw.buildMinAgeDays = bd;
  const cd = num("cache-min-age-days", values["cache-min-age-days"]);
  if (cd !== undefined) raw.cacheMinAgeDays = cd;
  const ms = num("min-size", values["min-size"]);
  if (ms !== undefined) raw.minSizeBytes = ms;
  return raw;
}

async function stateDirOnly(values: Values, io: CliIO): Promise<string> {
  if (values["state-dir"]) return resolve(io.cwd, values["state-dir"]);
  const raw = await rawConfigFrom(values, io.cwd);
  if (raw.stateDir) return resolve(io.cwd, raw.stateDir);
  const home = values.home ?? raw.home ?? homedir();
  return defaultStateDir(await realpath(home), io.env);
}

function humanIO(io: CliIO): HumanIO {
  return {
    stdinIsTTY: io.stdinIsTTY,
    stdoutIsTTY: io.stdoutIsTTY,
    env: io.env,
    write: (t) => io.out(t + "\n"),
    ask: (q) => io.ask(q),
  };
}

export async function runCli(argv: string[], io: CliIO, deps: Deps = defaultDeps()): Promise<number> {
  if (platform() === "win32") {
    io.err("disk-janitor supports macOS and Linux only\n");
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.err(`${escapeText((e as Error).message)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    io.out(HELP);
    return command || values.help ? 0 : 2;
  }
  try {
    switch (command) {
      case "scan":
        return await cmdScan(values, io, deps);
      case "plan":
        return await cmdPlan(values, io, deps);
      case "explain":
        return await cmdExplain(values, positionals[1], io, deps);
      case "approve":
        return await cmdApprove(values, positionals[1], io, deps);
      case "apply":
        return await cmdApply(values, positionals[1], io, deps);
      case "restore":
        return await cmdRestore(values, positionals[1], io, deps);
      case "purge":
        return await cmdPurge(values, io, deps);
      case "status":
        return await cmdStatus(values, io, deps);
      case "audit":
        return await cmdAudit(values, io);
      case "doctor":
        return await cmdDoctor(values, io, deps);
      default:
        io.err(`unknown command ${escapeText(command, 64)}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    return reportError(e, io);
  }
}

function reportError(e: unknown, io: CliIO): number {
  if (e instanceof UsageError) {
    io.err(`usage error: ${escapeText(e.message)}\n`);
    return 2;
  }
  if (e instanceof PlanTooOldError) {
    io.err(`usage error: ${escapeText(e.message)}\n`);
    return 2;
  }
  if (e instanceof ApplyError) {
    io.err(`error: ${escapeText(e.message, 2000)}\n`);
    for (const p of e.problems) io.err(`  - ${escapeText(p, 1000)}\n`);
    return 1;
  }
  if (
    e instanceof HumanRequiredError ||
    e instanceof RootsError ||
    e instanceof StateError ||
    e instanceof PlanIntegrityError ||
    e instanceof LockHeldError
  ) {
    io.err(`error: ${escapeText(e.message, 2000)}\n`);
    return 1;
  }
  const code = (e as NodeJS.ErrnoException).code;
  io.err(`error: ${escapeText(e instanceof Error ? e.message : String(e), 2000)}${code ? ` (${escapeText(String(code))})` : ""}\n`);
  return 1;
}

function need(arg: string | undefined, what: string): string {
  if (!arg) throw new UsageError(`${what} is required`);
  return arg;
}

async function cmdScan(values: Values, io: CliIO, deps: Deps): Promise<number> {
  const config = await resolveConfig(await rawConfigFrom(values, io.cwd), deps, { cwd: io.cwd, env: io.env });
  const result = await scan(config, deps);
  if (values.json) {
    io.out(
      safeJson(
        {
          roots: config.roots,
          candidates: [...result.fs, ...result.docker],
          reports: result.reports,
          skippedCount: result.skippedCount,
          skipped: values.verbose ? result.skipped : undefined,
          warnings: result.warnings,
          openHandleCheck: result.openHandleCheck,
        },
        2,
      ) + "\n",
    );
  } else {
    io.out(renderScan(result, { verbose: !!values.verbose, roots: config.roots }));
  }
  return 0;
}

async function cmdPlan(values: Values, io: CliIO, deps: Deps): Promise<number> {
  const config = await resolveConfig(await rawConfigFrom(values, io.cwd), deps, { cwd: io.cwd, env: io.env });
  const { plan, path } = await createPlan(config, deps, values.out ? resolve(io.cwd, values.out) : undefined);
  io.out(renderPlanSummary(plan).map((l) => l + "\n").join(""));
  io.out(`plan file:  ${escapeText(path, 1000)}\n\n`);
  io.out("nothing was changed. Review it with:\n");
  io.out(`  disk-janitor explain ${plan.id}\n`);
  io.out("then a human approves it in a terminal:\n");
  io.out(`  disk-janitor approve ${plan.id}\n`);
  return 0;
}

async function openStateForPlanless(values: Values, io: CliIO, roots: string[] = []) {
  return openState(await stateDirOnly(values, io), roots);
}

async function cmdExplain(values: Values, ref: string | undefined, io: CliIO, _deps: Deps): Promise<number> {
  const state = await openStateForPlanless(values, io);
  const plan = await loadPlan(need(ref, "plan"), state, io.cwd);
  io.out(renderPlanSummary(plan, 100000).slice(0, 5).map((l) => l + "\n").join(""));
  io.out("digest check: OK (the plan matches its digest)\n\n");
  for (const c of plan.candidates) {
    io.out(describeCandidate(c).map((l) => l + "\n").join(""));
    if (c.kind === "fs") {
      io.out(`            id ${c.id}, dev ${c.dev}, inode ${c.ino}, ${c.entries} entries, modified ${formatTime(c.mtimeMs)}\n`);
    }
  }
  if (plan.reports.length > 0) {
    io.out("\nreport-only findings:\n");
    for (const r of plan.reports) io.out(describeReport(r) + "\n");
  }
  io.out("\napply will: re-validate every candidate (same device and inode, no symlinks, nothing modified since the plan), then move it into quarantine with rename. Nothing is deleted until a separate human 'purge'.\n");
  if (Date.now() - plan.createdAt > MAX_PLAN_AGE_MS) io.out("note: this plan is older than 24 hours and can no longer be approved or applied.\n");
  return 0;
}

async function cmdApprove(values: Values, ref: string | undefined, io: CliIO, deps: Deps): Promise<number> {
  const human = humanIO(io);
  assertHumanSession(human, "approve");
  const state = await openStateForPlanless(values, io);
  const plan = await loadPlan(need(ref, "plan"), state, io.cwd);
  await openState(state.dir, plan.config.roots);
  const minutes = num("minutes", values.minutes);
  const validityMs = minutes === undefined ? DEFAULT_VALIDITY_MS : minutes * 60_000;
  if (validityMs <= 0 || validityMs > MAX_VALIDITY_MS) throw new UsageError("--minutes must be between 1 and 60");

  const result = await approvePlan(planningPorts(state, deps), human, plan, {
    validityMs,
    describe: (p, ms) => [
      ...renderPlanSummary(p),
      "",
      `Approving lets 'apply' move these directories into quarantine for ${Math.round(ms / 60_000)} minutes.`,
      "Nothing is deleted by apply; items stay restorable until a separate 'purge'.",
    ],
  });
  if (!result.approved) {
    io.err("not approved\n");
    return 1;
  }
  io.out(`approved until ${formatTime(result.record.expiresAt)}. Run: disk-janitor apply ${plan.id}\n`);
  return 0;
}

async function cmdApply(values: Values, ref: string | undefined, io: CliIO, deps: Deps): Promise<number> {
  const config = await resolveConfig(await rawConfigFrom(values, io.cwd), deps, { cwd: io.cwd, env: io.env });
  const state = await openStateFor(config);
  const plan = await loadPlan(need(ref, "plan"), state, io.cwd);
  const result = await applyPlan({ config, state, plan, deps });
  io.out(`applied ${plan.id}: ${result.moved.length} directories moved to quarantine\n`);
  for (const m of result.moved) io.out(`  ${formatBytes(m.size).padStart(10)}  ${escapeText(m.path, 400)}\n`);
  for (const d of result.docker) io.out(`  docker ${d.resource}: ${d.ok ? "pruned" : "FAILED"} ${escapeText(d.detail.replace(/\s+/g, " "), 200)}\n`);
  io.out(`quarantine: ${escapeText(result.quarantineDir, 1000)}\n`);
  io.out(`undo with:  disk-janitor restore ${plan.id}\n`);
  return result.docker.some((d) => !d.ok) ? 1 : 0;
}

async function cmdRestore(values: Values, selector: string | undefined, io: CliIO, deps: Deps): Promise<number> {
  const sel = need(selector, "plan id or path");
  const state = await openStateForPlanless(values, io);
  if (values["dry-run"]) {
    const checks = await previewRestore(state, deps, sel);
    if (checks.length === 0) io.out("nothing to restore for that selector\n");
    for (const c of checks) io.out(`${c.ok ? "would restore" : "cannot restore"} ${escapeText(c.entry.originalPath, 400)}${c.reason ? `: ${escapeText(c.reason)}` : ""}\n`);
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  const results = await restore(state, deps, new AuditLog(state, deps.now), sel);
  if (results.length === 0) {
    io.out("nothing to restore for that selector\n");
    return 1;
  }
  for (const r of results) io.out(`${r.ok ? "restored" : "REFUSED"} ${escapeText(r.entry.originalPath, 400)}${r.reason ? `: ${escapeText(r.reason)}` : ""}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

async function cmdPurge(values: Values, io: CliIO, deps: Deps): Promise<number> {
  const ttlDays = num("ttl-days", values["ttl-days"]) ?? DEFAULT_PURGE_TTL_DAYS;
  const state = await openStateForPlanless(values, io);
  const { items, problems } = await purgeCandidates(state, ttlDays * DAY_MS, deps.now());
  for (const p of problems) io.err(`warning: quarantine ${escapeText(p.planId)}: ${escapeText(p.reason)}\n`);
  if (items.length === 0) {
    io.out(`nothing to purge: no quarantined item is at least ${ttlDays} days old\n`);
    return 0;
  }
  const total = items.reduce((s, i) => s + i.entry.size, 0);
  const lines = [`purge would permanently delete ${items.length} quarantined item(s), ${formatBytes(total)}:`];
  for (const i of items) lines.push(`  ${formatBytes(i.entry.size).padStart(10)}  ${i.ageDays}d in quarantine  ${escapeText(i.entry.originalPath, 400)}  (${i.planId})`);
  if (values["dry-run"]) {
    io.out(lines.join("\n") + `\n(dry run: nothing deleted; confirmation code for a real purge: ${digestPrefix(purgeSetDigest(items))})\n`);
    return 0;
  }
  const human = humanIO(io);
  assertHumanSession(human, "purge");
  for (const l of lines) human.write(l);
  human.write("This cannot be undone.");
  const expected = digestPrefix(purgeSetDigest(items));
  if (!(await confirmByTyping(human, expected, "permanently delete them"))) {
    io.err("purge cancelled\n");
    return 1;
  }
  const result = await purgeItems(state, deps, new AuditLog(state, deps.now), items);
  io.out(`purged ${result.purged.length} item(s)\n`);
  for (const f of result.failed) io.err(`failed: ${escapeText(f.item.entry.originalPath, 400)}: ${escapeText(f.reason)}\n`);
  return result.failed.length === 0 ? 0 : 1;
}

async function cmdStatus(values: Values, io: CliIO, deps: Deps): Promise<number> {
  const state = await openStateForPlanless(values, io);
  const audit = await new AuditLog(state, deps.now).verify();
  const q = await listQuarantine(state);
  const plans = (await readdir(state.plansDir)).filter((n) => n.endsWith(".json"));
  const approvals = (await readdir(state.approvalsDir)).filter((n) => n.endsWith(".json"));
  const summary = q.manifests.map((m) => {
    const counts: Record<string, number> = {};
    let bytes = 0;
    for (const e of m.entries) {
      counts[e.status] = (counts[e.status] ?? 0) + 1;
      if (e.status === "quarantined" || e.status === "pending") bytes += e.size;
    }
    return { planId: m.planId, counts, quarantinedBytes: bytes };
  });
  const lockHeld = await lstat(state.lockPath).then(() => true, () => false);
  const data = {
    stateDir: state.dir,
    plans: plans.length,
    pendingApprovalFiles: approvals.length,
    quarantine: summary,
    quarantineProblems: q.problems,
    audit: { ok: audit.ok, entries: audit.count, head: audit.head, ...(audit.ok ? {} : { brokenAtLine: audit.line, reason: audit.reason }) },
    applyLockHeld: lockHeld,
  };
  if (values.json) {
    io.out(safeJson(data, 2) + "\n");
    return 0;
  }
  io.out(`state directory: ${escapeText(state.dir, 1000)}\n`);
  io.out(`plans: ${plans.length}, approval files: ${approvals.length}, apply lock: ${lockHeld ? "held/present" : "free"}\n`);
  if (summary.length === 0) io.out("quarantine: empty\n");
  for (const s of summary) {
    io.out(`quarantine ${s.planId}: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ")}; ${formatBytes(s.quarantinedBytes)} held\n`);
  }
  for (const p of q.problems) io.out(`quarantine problem ${escapeText(p.planId)}: ${escapeText(p.reason)}\n`);
  io.out(`audit log: ${audit.ok ? "chain OK" : `BROKEN at line ${audit.line} (${escapeText(audit.reason)})`}, ${audit.count} entries, head ${audit.head.slice(0, 16)}\n`);
  return audit.ok && q.problems.length === 0 ? 0 : 1;
}

async function cmdAudit(values: Values, io: CliIO): Promise<number> {
  const state = await openStateForPlanless(values, io);
  const log = new AuditLog(state);
  const v = await log.verify();
  for (const e of v.entries) io.out(safeJson(e) + "\n");
  if (!v.ok) {
    io.err(`audit chain BROKEN at line ${v.line}: ${escapeText(v.reason)}\n`);
    return 1;
  }
  io.err(`audit chain OK: ${v.count} entries, head ${v.head}\n`);
  return 0;
}

async function cmdDoctor(values: Values, io: CliIO, deps: Deps): Promise<number> {
  let failed = false;
  const line = (level: "ok" | "warn" | "FAIL", msg: string) => {
    if (level === "FAIL") failed = true;
    io.out(`${level.padEnd(4)}  ${msg}\n`);
  };
  line(platform() === "darwin" || platform() === "linux" ? "ok" : "FAIL", `platform ${platform()}/${arch()} (macOS and Linux are supported)`);
  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 22 ? "ok" : "FAIL", `node ${process.versions.node} (needs >= 22.12)`);
  const dir = await stateDirOnly(values, io);
  let rootsForCheck: string[] = [];
  try {
    const raw = await rawConfigFrom(values, io.cwd);
    if (raw.roots && raw.roots.length > 0) {
      rootsForCheck = (await resolveConfig(raw, deps, { cwd: io.cwd, env: io.env })).roots;
    }
  } catch (e) {
    line("warn", `could not validate configured roots: ${escapeText((e as Error).message)}`);
  }
  let state;
  try {
    state = await openState(dir, rootsForCheck);
    const st = await lstat(state.dir);
    const mode = st.mode & 0o777;
    line(mode === 0o700 ? "ok" : "warn", `state directory ${escapeText(state.dir, 500)} mode ${mode.toString(8)} (expected 700)`);
  } catch (e) {
    line("FAIL", `state directory: ${escapeText((e as Error).message, 500)}`);
    return 1;
  }
  try {
    const key = await loadKey(state, false);
    if (key === null) line("ok", "approval key not created yet (created on first approve with mode 0600)");
    else line("ok", "approval key present, mode 0600, owned by you");
  } catch (e) {
    line("FAIL", `approval key: ${escapeText((e as Error).message)}`);
  }
  const audit = await new AuditLog(state, deps.now).verify();
  line(audit.ok ? "ok" : "FAIL", audit.ok ? `audit chain intact (${audit.count} entries)` : `audit chain broken at line ${audit.line}: ${escapeText(audit.reason)}`);
  // same-device rename inside the quarantine area
  const probe = await mkdtemp(join(state.quarantineDir, ".doctor-"));
  try {
    await mkdir(join(probe, "a"));
    await writeFile(join(probe, "a", "f"), "x");
    await rename(join(probe, "a"), join(probe, "b"));
    line("ok", "rename within the quarantine works");
  } catch (e) {
    line("FAIL", `rename within the quarantine failed: ${escapeText((e as Error).message)}`);
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  const sdev = (await lstat(state.dir, { bigint: true })).dev;
  for (const root of rootsForCheck) {
    const rdev = (await lstat(root, { bigint: true })).dev;
    line(rdev === sdev ? "ok" : "warn", rdev === sdev ? `root ${escapeText(root, 300)} is on the same file system as the quarantine` : `root ${escapeText(root, 300)} is on a different file system than the state directory: candidates there will be refused (rename cannot cross devices)`);
  }
  const git = await deps.run("git", ["--version"]);
  line(git.code === 0 ? "ok" : "warn", git.code === 0 ? escapeText(git.stdout.trim()) : "git not found: node_modules and build-output detectors will skip git-managed projects");
  const lsof = await deps.run("lsof", ["-v"]);
  line(lsof.error === "ENOENT" ? "warn" : "ok", lsof.error === "ENOENT" ? "lsof not found: the open-file safety check is disabled" : "lsof available: open-file check enabled");
  const docker = await deps.run("docker", ["--version"]);
  line("ok", docker.code === 0 ? escapeText(docker.stdout.trim()) : "docker not found (docker detector will report it as unavailable)");
  line("ok", `stdin tty: ${io.stdinIsTTY}, stdout tty: ${io.stdoutIsTTY} (approve and purge need both)`);
  return failed ? 1 : 0;
}

export function realIO(): CliIO {
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
    env: process.env,
    cwd: process.cwd(),
    ask: (q) =>
      new Promise((resolveAnswer) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.question(q, (a) => {
          rl.close();
          resolveAnswer(a);
        });
      }),
  };
}
