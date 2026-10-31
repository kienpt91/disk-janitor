// Public API, grouped by layer. The composition functions at the end are the convenient entry
// points; the layers above them can be used on their own (for example the domain is pure).

// ---- domain ----
export * from "./domain/model/types.js";
export * from "./domain/model/config.js";
export * from "./domain/events.js";
export * from "./domain/errors.js";
export * from "./domain/shared/escape.js";
export { isInside, isCanonicalAbsolute } from "./domain/shared/paths.js";
export * from "./domain/policy/protected.js";
export * from "./domain/policy/roots.js";
export * from "./domain/policy/human.js";
export { baseFor } from "./domain/policy/bases.js";
export * from "./domain/approval/approval.js";
export * from "./domain/audit/chain.js";
export {
  PlanAggregate,
  PlanIntegrityError,
  PlanInvariantError,
  PlanTooOldError,
  PLAN_ID_RE,
  MAX_PLAN_BYTES,
  MAX_PLAN_AGE_MS,
  computePlanDigest,
  isPlanTooOld,
  newPlanId,
  parsePlan,
  planTotals,
  serializePlan,
  type PlanInput,
} from "./domain/plan/plan.js";
export { BUILD_OUTPUTS, CACHE_LOCATIONS, DOCKER_COMMANDS } from "./domain/discovery/catalog.js";
export { parseDockerDf, parseDockerSize, parseWorktreeList } from "./domain/discovery/eligibility.js";
export { purgeSetDigest } from "./domain/quarantine/manifest.js";

// ---- application ----
export * from "./application/ports/common.js";
export * from "./application/ports/planning.js";
export * from "./application/ports/discovery.js";
export * from "./application/ports/quarantine.js";
export * from "./application/human-confirmation.js";
export { approvePlan } from "./application/approvals.js";
export { validateRoots } from "./application/validate-roots.js";
export { discoverCandidates, MAX_DIRS_VISITED, type DiscoveryPorts, type ScanResult } from "./application/discover.js";
export { inspectTree } from "./application/inspect-tree.js";
export { findSymlinkInChain } from "./application/inspection.js";

// ---- infrastructure ----
export { nodeFs } from "./infrastructure/fs/node-fs.js";
export * from "./infrastructure/fs/file-lock.js";
export { runCommand, type CommandResult, type CommandRunner, type RunOptions } from "./infrastructure/process/command-runner.js";
export * from "./infrastructure/config-file.js";
export * from "./infrastructure/state/state-dir.js";
export * from "./infrastructure/state/key-store.js";
export * from "./infrastructure/state/audit-log.js";
export { approvalPath } from "./infrastructure/state/approval-store.js";
export * from "./infrastructure/cli/format.js";
export * from "./infrastructure/cli/cli.js";

// ---- composition ----
export { defaultDeps, type Deps } from "./composition/deps.js";
export * from "./composition/planning.js";
export { scan, discoveryPorts } from "./composition/discovery.js";
export {
  applyPlan,
  ApplyError,
  DEFAULT_PURGE_TTL_DAYS,
  listQuarantine,
  previewRestore,
  purgeCandidates,
  purgeItems,
  QuarantineError,
  readManifest,
  restore,
  type ApplyFailure,
  type ApplyInput,
  type ApplyResult,
  type ManifestBody,
  type ManifestEntry,
  type PurgeItem,
  type PurgeResult,
  type QuarantineListing,
  type RestoreCheck,
} from "./composition/disposal.js";
