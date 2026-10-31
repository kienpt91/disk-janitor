import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { canonicalJson, sha256Hex } from "./domain/shared/canonical.js";
import { configCore, type Config } from "./domain/model/config.js";
import { safeJson } from "./domain/shared/escape.js";
import { isCanonicalAbsolute } from "./domain/shared/paths.js";
import type { ScanResult } from "./scan.js";
import { arr, bool, int, literal, obj, opt, parseJson, SchemaError, str, union, type Parser } from "./domain/shared/schema.js";
import { DETECTOR_IDS, PLAN_VERSION, type Candidate, type ConfigCore, type Plan } from "./domain/model/types.js";

export const MAX_PLAN_BYTES = 8 * 1024 * 1024;
export const PLAN_ID_RE = /^plan-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]{1,20}$/;

export class PlanIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanIntegrityError";
  }
}

export function newPlanId(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `plan-${stamp}-${randomBytes(4).toString("hex")}`;
}

const canonicalPath: Parser<string> = (v, p) => {
  const s = str({ min: 1, max: 4096 })(v, p);
  if (!isCanonicalAbsolute(s)) throw new SchemaError(`${p}: not a canonical absolute path`);
  return s;
};

const configParser = obj({
  roots: arr(canonicalPath, { max: 64 }),
  home: canonicalPath,
  detectors: arr(literal(...DETECTOR_IDS), { max: 16 }),
  dockerApply: bool(),
  staleDays: int({ max: 3650 }),
  buildMinAgeDays: int({ max: 3650 }),
  cacheMinAgeDays: int({ max: 3650 }),
  minSizeBytes: int(),
  maxDepth: int({ min: 1, max: 16 }),
  maxCandidates: int({ min: 1, max: 5000 }),
  maxEntriesPerCandidate: int({ min: 1, max: 5_000_000 }),
});

const candidateId = str({ pattern: /^c[0-9]{4,6}$/, max: 8 });

const fsCandidateParser = obj({
  kind: literal("fs"),
  id: candidateId,
  detector: literal(...DETECTOR_IDS),
  path: canonicalPath,
  type: literal("dir"),
  dev: str({ pattern: DECIMAL }),
  ino: str({ pattern: DECIMAL }),
  size: int(),
  entries: int(),
  mtimeMs: int(),
  newestMtimeMs: int(),
  ageDays: int(),
  reason: str({ max: 1024 }),
  regenerate: str({ max: 4200 }),
});

const dockerCandidateParser = obj({
  kind: literal("docker"),
  id: candidateId,
  detector: literal("docker"),
  resource: literal("build-cache", "dangling-images"),
  size: int(),
  reason: str({ max: 1024 }),
  regenerate: str({ max: 1024 }),
});

const reportParser = obj({
  detector: literal(...DETECTOR_IDS),
  title: str({ max: 256 }),
  detail: str({ max: 4600 }),
  size: opt(int()),
  path: opt(str({ max: 4096 })),
});

const planParser = obj({
  version: literal(PLAN_VERSION),
  id: str({ pattern: PLAN_ID_RE, max: 64 }),
  createdAt: int(),
  configDigest: str({ pattern: HEX64 }),
  config: configParser,
  candidates: arr(union<Candidate>("kind", { fs: fsCandidateParser as Parser<Candidate>, docker: dockerCandidateParser as Parser<Candidate> }), {
    max: 5000,
  }),
  reports: arr(reportParser, { max: 5000 }),
  digest: str({ pattern: HEX64 }),
});

/** SHA-256 over the canonical JSON of the plan without its own digest field. */
export function computePlanDigest(plan: Omit<Plan, "digest"> | Plan): string {
  const { digest: _ignored, ...rest } = plan as Plan;
  return sha256Hex(canonicalJson(rest));
}

export function buildPlan(config: Config, result: ScanResult, nowMs: number): Plan {
  const candidates: Candidate[] = [];
  let n = 0;
  const nextId = () => `c${String(++n).padStart(4, "0")}`;
  for (const c of result.fs) candidates.push({ ...c, id: nextId() });
  for (const c of result.docker) candidates.push({ ...c, id: nextId() });
  const core: ConfigCore = configCore(config);
  const body = {
    version: PLAN_VERSION,
    id: newPlanId(nowMs),
    createdAt: nowMs,
    configDigest: config.digest,
    config: core,
    candidates,
    reports: result.reports.slice(0, 5000),
  } as const;
  const plan: Plan = { ...body, digest: "" };
  plan.digest = computePlanDigest(plan);
  return plan;
}

/** Parse a plan with strict schema and size limit; verify its digest and internal consistency. */
export function parsePlan(text: string): Plan {
  let parsed: Plan;
  try {
    parsed = parseJson(text, planParser, MAX_PLAN_BYTES, "plan") as unknown as Plan;
  } catch (e) {
    if (e instanceof SchemaError) throw new PlanIntegrityError(e.message);
    throw e;
  }
  if (computePlanDigest(parsed) !== parsed.digest) {
    throw new PlanIntegrityError("plan digest mismatch: the plan was modified after it was created");
  }
  if (sha256Hex(canonicalJson(parsed.config)) !== parsed.configDigest) {
    throw new PlanIntegrityError("plan config digest mismatch");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const c of parsed.candidates) {
    if (ids.has(c.id)) throw new PlanIntegrityError("duplicate candidate id");
    ids.add(c.id);
    if (c.kind === "fs") {
      if (paths.has(c.path)) throw new PlanIntegrityError("duplicate candidate path");
      paths.add(c.path);
    }
  }
  return parsed;
}

export async function writePlanFile(path: string, plan: Plan): Promise<void> {
  await writeFile(path, safeJson(plan, 2) + "\n", { mode: 0o600, flag: "wx" });
}

export function planTotals(plan: Plan): { fsBytes: number; dockerBytes: number; fsCount: number; dockerCount: number } {
  let fsBytes = 0;
  let dockerBytes = 0;
  let fsCount = 0;
  let dockerCount = 0;
  for (const c of plan.candidates) {
    if (c.kind === "fs") {
      fsBytes += c.size;
      fsCount++;
    } else {
      dockerBytes += c.size;
      dockerCount++;
    }
  }
  return { fsBytes, dockerBytes, fsCount, dockerCount };
}
