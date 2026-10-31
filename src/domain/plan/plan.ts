import { canonicalJson, sha256Hex, sortKeys } from "../shared/canonical.js";
import { configCore, type Config } from "../model/config.js";
import { baseFor } from "../policy/bases.js";
import { protectedReason } from "../policy/protected.js";
import { isCanonicalAbsolute, isInside } from "../shared/paths.js";
import { safeJson } from "../shared/escape.js";
import { arr, bool, int, literal, obj, opt, parseJson, SchemaError, str, union, type Parser } from "../shared/schema.js";
import { DETECTOR_IDS, PLAN_VERSION, type Candidate, type ConfigCore, type DockerCandidate, type FsCandidate, type Plan, type ReportItem } from "../model/types.js";

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

/** Plan id from the creation time and 8 random hex characters supplied by the id source. */
export function newPlanId(nowMs: number, hex8: string): string {
  if (!/^[0-9a-f]{8}$/.test(hex8)) throw new PlanIntegrityError("plan id needs 8 hex characters");
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `plan-${stamp}-${hex8}`;
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

/** What discovery hands to planning: file-system candidates, docker candidates and report-only findings. */
export interface PlanInput {
  fs: Array<Omit<FsCandidate, "id">>;
  docker: Array<Omit<DockerCandidate, "id">>;
  reports: ReportItem[];
}

export function buildPlan(config: Config, result: PlanInput, nowMs: number, idHex8: string): Plan {
  const candidates: Candidate[] = [];
  let n = 0;
  const nextId = () => `c${String(++n).padStart(4, "0")}`;
  for (const c of result.fs) candidates.push({ ...c, id: nextId() });
  for (const c of result.docker) candidates.push({ ...c, id: nextId() });
  const core: ConfigCore = configCore(config);
  const body = {
    version: PLAN_VERSION,
    id: newPlanId(nowMs, idHex8),
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

/** Plan text as written to disk: pretty JSON with sorted keys and display-unsafe characters escaped. */
export function serializePlan(plan: Plan): string {
  return safeJson(sortKeys(plan), 2) + "\n";
}

/** Plans older than this can no longer be approved or applied. */
export const MAX_PLAN_AGE_MS = 24 * 60 * 60_000;

export class PlanTooOldError extends Error {
  constructor() {
    super("the plan is older than 24 hours; create a new one");
    this.name = "PlanTooOldError";
  }
}

export function isPlanTooOld(plan: Pick<Plan, "createdAt">, nowMs: number): boolean {
  return nowMs - plan.createdAt > MAX_PLAN_AGE_MS;
}

export class PlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanInvariantError";
  }
}

/**
 * The Plan aggregate. A plan can only come into existence through `create` (which enforces the
 * invariants below) or `parse` (which verifies a stored plan's schema and digest); its `document`
 * is immutable data whose digest is what a human approves.
 *
 * Invariants of `create`: candidate paths are canonical, unique and never nested in one another;
 * docker candidates exist only when docker apply is enabled; every candidate lives under a
 * configured root (or is exactly an enabled package-cache location) and is not protected.
 */
export class PlanAggregate {
  private constructor(readonly document: Plan) {}

  get id(): string {
    return this.document.id;
  }

  get digest(): string {
    return this.document.digest;
  }

  static create(config: Config, input: PlanInput, nowMs: number, idHex8: string): PlanAggregate {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new PlanInvariantError("creation time must be a non-negative integer");
    if (input.docker.length > 0 && !config.dockerApply) {
      throw new PlanInvariantError("docker candidates are only allowed when docker apply is enabled");
    }
    const seen: string[] = [];
    for (const c of input.fs) {
      if (!isCanonicalAbsolute(c.path)) throw new PlanInvariantError(`candidate path is not canonical: ${c.path}`);
      if (c.size < 0 || c.entries < 0) throw new PlanInvariantError("candidate size and entry count cannot be negative");
      if (!baseFor(config, c.path)) throw new PlanInvariantError(`candidate is outside the configured roots: ${c.path}`);
      const prot = protectedReason(c.path, [config.home]);
      if (prot) throw new PlanInvariantError(`candidate is protected (${prot}): ${c.path}`);
      for (const other of seen) {
        if (other === c.path) throw new PlanInvariantError(`duplicate candidate path: ${c.path}`);
        if (isInside(other, c.path) || isInside(c.path, other)) throw new PlanInvariantError(`candidates must not be nested: ${other} and ${c.path}`);
      }
      seen.push(c.path);
    }
    return new PlanAggregate(buildPlan(config, input, nowMs, idHex8));
  }

  /** Parse stored plan text: strict schema, size limit, digest and consistency checks. */
  static parse(text: string): PlanAggregate {
    return new PlanAggregate(parsePlan(text));
  }

  serialize(): string {
    return serializePlan(this.document);
  }

  totals(): ReturnType<typeof planTotals> {
    return planTotals(this.document);
  }
}
