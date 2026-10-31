import { escapeText } from "../../domain/shared/escape.js";
import type { ScanResult } from "../../application/discover.js";
import type { Candidate, Plan, ReportItem } from "../../domain/model/types.js";

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toString() : v.toFixed(1)} ${units[i]}`;
}

export function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

const e = (s: string, n = 400) => escapeText(s, n);

export function describeCandidate(c: Candidate): string[] {
  if (c.kind === "docker") {
    return [
      `${formatBytes(c.size).padStart(10)}  docker       ${c.resource} (irreversible: not quarantined)`,
      `            why: ${e(c.reason)}`,
      `            regenerate: ${e(c.regenerate)}`,
    ];
  }
  return [
    `${formatBytes(c.size).padStart(10)}  ${String(c.ageDays).padStart(4)}d  ${c.detector.padEnd(13)} ${e(c.path)}`,
    `            why: ${e(c.reason)}`,
    `            regenerate: ${e(c.regenerate)}`,
  ];
}

export function describeReport(r: ReportItem): string {
  return `  [${r.detector}] ${e(r.title)}${r.path ? ` ${e(r.path)}` : ""}: ${e(r.detail)}`;
}

export function renderScan(result: ScanResult, opts: { verbose: boolean; roots: string[] }): string {
  const lines: string[] = [];
  lines.push("disk-janitor scan (read-only: nothing was changed)");
  lines.push(`roots: ${opts.roots.map((r) => e(r)).join(", ")}`);
  lines.push(
    result.openHandleCheck === "performed"
      ? "open-file check: performed (lsof)"
      : "open-file check: NOT performed (lsof unavailable); make sure nothing is using these directories",
  );
  lines.push("");
  const all: Candidate[] = [...result.fs.map((c) => ({ ...c, id: "" })), ...result.docker.map((c) => ({ ...c, id: "" }))];
  if (all.length === 0) lines.push("no candidates found");
  else {
    lines.push("      SIZE   AGE  DETECTOR      PATH");
    for (const c of all) lines.push(...describeCandidate(c));
    const total = all.reduce((s, c) => s + c.size, 0);
    lines.push("");
    lines.push(`total reclaimable: ${formatBytes(total)} in ${all.length} candidate${all.length === 1 ? "" : "s"}`);
  }
  if (result.reports.length > 0) {
    lines.push("");
    lines.push("report-only findings (never acted on):");
    for (const r of result.reports) lines.push(describeReport(r));
  }
  lines.push("");
  lines.push(`skipped: ${result.skippedCount} (${result.skippedCount === 0 ? "none" : opts.verbose ? "listed below" : "use --verbose to list them with reasons"})`);
  if (opts.verbose) for (const s of result.skipped) lines.push(`  [${s.detector}] ${e(s.path)}: ${e(s.reason)}`);
  for (const w of result.warnings) lines.push(`warning: ${e(w)}`);
  return lines.join("\n") + "\n";
}

export function renderPlanSummary(plan: Plan, listLimit = 25): string[] {
  const lines: string[] = [];
  const fsC = plan.candidates.filter((c) => c.kind === "fs");
  const dockerC = plan.candidates.filter((c) => c.kind === "docker");
  const total = plan.candidates.reduce((s, c) => s + c.size, 0);
  lines.push(`plan:       ${plan.id}`);
  lines.push(`digest:     ${plan.digest}`);
  lines.push(`created:    ${formatTime(plan.createdAt)}`);
  lines.push(`roots:      ${plan.config.roots.map((r) => e(r)).join(", ")}`);
  lines.push(`candidates: ${plan.candidates.length} (${fsC.length} directories to quarantine, ${dockerC.length} docker prune), ${formatBytes(total)}`);
  for (const c of plan.candidates.slice(0, listLimit)) {
    lines.push(c.kind === "fs" ? `  ${formatBytes(c.size).padStart(10)}  ${e(c.path)}` : `  ${formatBytes(c.size).padStart(10)}  docker ${c.resource}`);
  }
  if (plan.candidates.length > listLimit) lines.push(`  ... and ${plan.candidates.length - listLimit} more (see 'explain')`);
  if (dockerC.length > 0) lines.push("WARNING: docker prunes are irreversible and are not quarantined.");
  return lines;
}

export interface ApprovalEnv {
  DOCKER_HOST?: string | undefined;
  DOCKER_CONTEXT?: string | undefined;
  DOCKER_CONFIG?: string | undefined;
}

/**
 * The approval screen header. It never contains the plan digest: the human has to read the digest
 * from `explain` and type it back. Docker candidates name the daemon the prune will really hit.
 */
export function renderApprovalHeader(plan: Plan, validityMs: number, env: ApprovalEnv = {}): string[] {
  const fsC = plan.candidates.filter((c) => c.kind === "fs");
  const dockerC = plan.candidates.filter((c) => c.kind === "docker");
  const total = plan.candidates.reduce((s, c) => s + c.size, 0);
  const lines = [
    `plan:       ${plan.id}`,
    `created:    ${formatTime(plan.createdAt)}`,
    `roots:      ${plan.config.roots.map((r) => e(r)).join(", ")}`,
    `candidates: ${plan.candidates.length} (${fsC.length} directories to quarantine, ${dockerC.length} docker prune), ${formatBytes(total)}`,
    "",
    `Approving lets 'apply' move the directories listed below into quarantine for ${Math.round(validityMs / 60_000)} minutes.`,
    "Nothing is deleted by apply; directories stay restorable until a separate 'purge'.",
  ];
  if (dockerC.length > 0) {
    lines.push(
      "WARNING: docker prunes are IRREVERSIBLE, are not quarantined, and run against the docker daemon selected by:",
      `  DOCKER_HOST=${env.DOCKER_HOST !== undefined ? e(env.DOCKER_HOST, 200) : "(unset: the default local daemon)"}`,
      `  DOCKER_CONTEXT=${env.DOCKER_CONTEXT !== undefined ? e(env.DOCKER_CONTEXT, 200) : "(unset: the current docker context)"}`,
      `  DOCKER_CONFIG=${env.DOCKER_CONFIG !== undefined ? e(env.DOCKER_CONFIG, 200) : "(unset)"}`,
    );
  }
  lines.push("", "Every candidate follows:");
  return lines;
}

/** One line per candidate, all of them. */
export function renderApprovalCandidates(plan: Plan): string[] {
  return plan.candidates.map((c) =>
    c.kind === "fs" ? `  ${formatBytes(c.size).padStart(10)}  ${e(c.path, 600)}` : `  ${formatBytes(c.size).padStart(10)}  docker ${c.resource} (irreversible)`,
  );
}
