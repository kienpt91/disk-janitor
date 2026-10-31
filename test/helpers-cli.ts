import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type CliIO } from "../src/cli.js";
import type { Deps } from "../src/deps.js";
import { parsePlan } from "../src/plan.js";
import { openState, type State } from "../src/state.js";
import type { Plan } from "../src/domain/model/types.js";
import type { Sandbox } from "./helpers.js";
import { testDeps } from "./helpers.js";

export interface FakeIO extends CliIO {
  stdout(): string;
  stderr(): string;
  /** Questions the CLI asked, in order. */
  asked: string[];
  /** Answers still queued. */
  answers: string[];
}

export interface IOOptions {
  tty?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  answers?: string[];
}

export function makeIO(sb: Sandbox, opts: IOOptions = {}): FakeIO {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  return {
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    stdinIsTTY: opts.stdinIsTTY ?? opts.tty ?? false,
    stdoutIsTTY: opts.stdoutIsTTY ?? opts.tty ?? false,
    env: opts.env ?? {},
    cwd: opts.cwd ?? sb.base,
    ask: async (q) => {
      asked.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error("unexpected question: " + q);
      return a;
    },
    stdout: () => out,
    stderr: () => err,
    asked,
    answers,
  };
}

/** Flags that pin roots, home and state to the sandbox. */
export function baseArgs(sb: Sandbox): string[] {
  return ["--root", sb.projects, "--home", sb.home, "--state-dir", sb.state, "--min-size", "1"];
}

export interface Ran {
  code: number;
  out: string;
  err: string;
  io: FakeIO;
}

export async function cli(sb: Sandbox, argv: string[], deps: Deps = testDeps(), opts: IOOptions = {}): Promise<Ran> {
  const io = makeIO(sb, opts);
  const code = await runCli(argv, io, deps);
  return { code, out: io.stdout(), err: io.stderr(), io };
}

export interface CliPlan {
  id: string;
  digest: string;
  file: string;
  plan: Plan;
}

/** Run `plan` through the CLI and load the written file. */
export async function cliPlan(sb: Sandbox, deps: Deps = testDeps(), extra: string[] = []): Promise<CliPlan> {
  const r = await cli(sb, ["plan", ...baseArgs(sb), ...extra], deps);
  if (r.code !== 0) throw new Error("plan failed: " + r.err);
  const id = /plan:\s+(plan-\S+)/.exec(r.out)?.[1];
  if (!id) throw new Error("no plan id in output: " + r.out);
  const file = join(sb.state, "plans", `${id}.json`);
  const plan = parsePlan(readFileSync(file, "utf8"));
  return { id, digest: plan.digest, file, plan };
}

/** Human approval through the CLI with a TTY and the correct digest prefix typed. */
export async function cliApprove(sb: Sandbox, p: CliPlan, deps: Deps = testDeps(), extra: string[] = []): Promise<Ran> {
  return cli(sb, ["approve", p.id, "--state-dir", sb.state, ...extra], deps, { tty: true, answers: [p.digest.slice(0, 8)] });
}

export async function stateOf(sb: Sandbox): Promise<State> {
  return openState(sb.state, [sb.projects]);
}

export function auditEvents(sb: Sandbox): string[] {
  const text = readFileSync(join(sb.state, "audit.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { event: string }).event);
}

export function tamperFile(path: string, from: RegExp, to: string): void {
  const text = readFileSync(path, "utf8");
  if (!from.test(text)) throw new Error("pattern not found in " + path);
  writeFileSync(path, text.replace(from, to));
}

export function approvalFiles(sb: Sandbox): string[] {
  return readdirSync(join(sb.state, "approvals")).filter((n) => n.endsWith(".json"));
}

/** A line is safe when it has only printable ASCII plus letters, numbers, punctuation, symbols and marks. */
export const SAFE_LINE = /^[\x20-\x7e\p{L}\p{N}\p{P}\p{S}\p{M}]*$/u;

export function unsafeLines(text: string): string[] {
  return text.split("\n").filter((l) => !SAFE_LINE.test(l));
}
