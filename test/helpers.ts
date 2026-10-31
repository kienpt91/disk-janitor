import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync, lutimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { AuditLog } from "../src/audit.js";
import { issueApproval } from "../src/approval.js";
import { resolveConfig, type Config, type RawConfig } from "../src/config.js";
import { defaultDeps, runCommand, type CommandResult, type Deps } from "../src/deps.js";
import { buildPlan } from "../src/plan.js";
import { scan } from "../src/scan.js";
import { openState, type State } from "../src/state.js";
import type { Plan } from "../src/domain/model/types.js";

export const DAY = 86_400_000;

export interface Sandbox {
  /** Canonical temp directory that holds everything below. */
  base: string;
  home: string;
  projects: string;
  state: string;
  cleanup(): void;
}

const created: Sandbox[] = [];

afterEach(() => {
  while (created.length > 0) (created.pop() as Sandbox).cleanup();
});

/** A throwaway fake HOME with a projects root and a state directory, all under the OS temp dir. */
export function makeSandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dj-test-")));
  const home = join(base, "home");
  const projects = join(home, "projects");
  const state = join(base, "state");
  mkdirSync(projects, { recursive: true });
  const sb: Sandbox = {
    base,
    home,
    projects,
    state,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
  created.push(sb);
  return sb;
}

export function writeBytes(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 0x61));
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Set atime/mtime of every entry below (and including) `path` to `days` days before `now`. */
export function ageTree(path: string, days: number, now = Date.now()): void {
  const t = new Date(now - days * DAY);
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    if (st.isSymbolicLink()) lutimesSync(p, t, t);
    else utimesSync(p, t, t);
  };
  walk(path);
}

/** Deterministic content hash of a tree: names, types, file bytes, symlink targets. */
export function treeHash(path: string): string {
  const h = createHash("sha256");
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) h.update(`L ${rel} -> ${readlinkSync(p)}\n`);
    else if (st.isDirectory()) {
      h.update(`D ${rel}\n`);
      for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`);
    } else h.update(`F ${rel} ${st.size}\n`).update(readFileSync(p));
  };
  walk(path, "");
  return h.digest("hex");
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

export function gitInit(dir: string, gitignore?: string): void {
  git(dir, "init", "-q", "-b", "main");
  if (gitignore !== undefined) writeText(join(dir, ".gitignore"), gitignore);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init", "--allow-empty");
}

export interface ProjectOptions {
  /** Bytes of the single file inside node_modules (default 4096). */
  nodeModules?: number;
  lockfile?: string | null;
  git?: boolean | string;
  /** Age everything this many days (default 60). */
  ageDays?: number;
  extraFiles?: Record<string, string>;
}

/** A realistic-enough JS project: package.json, lockfile, a source file, node_modules. */
export function makeProject(dir: string, opts: ProjectOptions = {}): string {
  const lock = opts.lockfile === undefined ? "package-lock.json" : opts.lockfile;
  writeText(join(dir, "package.json"), '{"name":"p","version":"1.0.0"}\n');
  if (lock) writeText(join(dir, lock), "{}\n");
  writeText(join(dir, "src", "index.js"), "console.log(1)\n");
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) writeText(join(dir, rel), content);
  writeBytes(join(dir, "node_modules", "dep", "index.js"), opts.nodeModules ?? 4096);
  if (opts.git) gitInit(dir, typeof opts.git === "string" ? opts.git : "node_modules\n");
  ageTree(dir, opts.ageDays ?? 60);
  return dir;
}

export interface FakeRunOptions {
  /** Paths lsof reports as open. undefined: lsof is not installed. */
  lsof?: string[];
  /** Handler for docker; return undefined to behave as if docker is not installed. */
  docker?: (args: readonly string[]) => Partial<CommandResult> | undefined;
}

export interface FakeRun {
  run: Deps["run"];
  calls: Array<{ command: string; args: readonly string[] }>;
}

/** Command runner: real git, scripted lsof and docker. Records every call. */
export function fakeRun(opts: FakeRunOptions = {}): FakeRun {
  const calls: FakeRun["calls"] = [];
  const run: Deps["run"] = async (command, args, o) => {
    calls.push({ command, args });
    if (command === "lsof") {
      if (opts.lsof === undefined) return { code: null, stdout: "", stderr: "", error: "ENOENT" };
      return { code: 0, stdout: opts.lsof.map((p, i) => `p${100 + i}\nf1\nn${p}\n`).join(""), stderr: "" };
    }
    if (command === "docker") {
      const res = opts.docker?.(args);
      if (!res) return { code: null, stdout: "", stderr: "", error: "ENOENT" };
      return { code: 0, stdout: "", stderr: "", ...res };
    }
    return runCommand(command, args, { ...o, env: { ...GIT_ENV, ...(o?.env ?? {}) } });
  };
  return { run, calls };
}

export function testDeps(opts: FakeRunOptions & { now?: () => number; hooks?: Deps["hooks"]; fs?: Deps["fs"] } = {}): Deps & { calls: FakeRun["calls"] } {
  const { run, calls } = fakeRun(opts);
  const base = defaultDeps();
  return { ...base, run, now: opts.now ?? base.now, ...(opts.hooks ? { hooks: opts.hooks } : {}), ...(opts.fs ? { fs: opts.fs } : {}), calls };
}

/** Config for a sandbox: root = projects, fake home, private state dir, small size threshold. */
export async function makeConfig(sb: Sandbox, overrides: RawConfig = {}, deps: Deps = testDeps()): Promise<Config> {
  return resolveConfig(
    { roots: [sb.projects], home: sb.home, stateDir: sb.state, minSizeBytes: 1, staleDays: 30, ...overrides },
    deps,
    { env: { XDG_STATE_HOME: undefined } },
  );
}

export interface Planned {
  config: Config;
  deps: Deps;
  state: State;
  plan: Plan;
}

/** Scan, plan (in memory only) and open the state directory. */
export async function planFor(sb: Sandbox, overrides: RawConfig = {}, deps: Deps = testDeps()): Promise<Planned> {
  const config = await makeConfig(sb, overrides, deps);
  const state = await openState(config.stateDir, config.roots);
  const result = await scan(config, deps);
  const plan = buildPlan(config, result, deps.now());
  return { config, deps, state, plan };
}

/** Stand-in for the human: issue an approval record directly (the CLI would do this after the TTY checks). */
export async function approveAsHuman(state: State, plan: Plan, deps: Deps, validityMs?: number) {
  const rec = await issueApproval(state, plan, deps.now(), validityMs);
  await new AuditLog(state, deps.now).append("approval-issued", { planId: plan.id, planDigest: plan.digest, expiresAt: rec.expiresAt, nonce: rec.nonce });
  return rec;
}

/** A realistic mixed tree used by several suites. Returns the project directories. */
export function makeMixedTree(sb: Sandbox) {
  const webapp = makeProject(join(sb.projects, "webapp"), { git: "node_modules\ndist\n", nodeModules: 8192 });
  writeBytes(join(webapp, "dist", "bundle.js"), 4096);
  ageTree(join(webapp, "dist"), 60);
  const api = makeProject(join(sb.projects, "api"), { lockfile: "pnpm-lock.yaml", nodeModules: 6000 });
  writeText(join(api, "Cargo.toml"), "[package]\nname=\"api\"\n");
  writeBytes(join(api, "target", "debug", "bin"), 5000);
  ageTree(api, 60);
  const wip = makeProject(join(sb.projects, "wip"), { git: true, ageDays: 60 });
  writeText(join(wip, "notes.txt"), "uncommitted\n");
  const fresh = makeProject(join(sb.projects, "fresh"), { ageDays: 1 });
  writeText(join(sb.home, "Documents", "taxes.txt"), "tax records\n");
  writeText(join(sb.home, ".ssh", "id_demo"), "not a real key\n");
  return { webapp, api, wip, fresh };
}
