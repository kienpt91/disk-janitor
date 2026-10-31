// Findings: everything one discovery run produced. The aggregate keeps the run's invariants: the
// skipped list is bounded (with an exact count), no Candidate lies inside another, and the
// listed Candidates are ordered largest first and capped.

import { isInside } from "../shared/paths.js";
import type { FsFinding } from "../model/candidate.js";
import type { DetectorId, ReportItem, SkippedItem } from "../model/types.js";

export const MAX_SKIPPED = 2000;

export interface FindingsSummary {
  fs: FsFinding[];
  reports: ReportItem[];
  skipped: SkippedItem[];
  skippedCount: number;
  warnings: string[];
}

export class Findings {
  private readonly candidates: FsFinding[] = [];
  private readonly reports: ReportItem[] = [];
  private readonly skipped: SkippedItem[] = [];
  private skippedCount = 0;
  private readonly warnings: string[] = [];

  accept(candidate: FsFinding): void {
    this.candidates.push(candidate);
  }

  report(item: ReportItem): void {
    this.reports.push(item);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** Record a path that was looked at and rejected. Only the first MAX_SKIPPED are kept, all are counted. */
  skip(detector: DetectorId, path: string, reason: string): void {
    this.skippedCount++;
    if (this.skipped.length < MAX_SKIPPED) this.skipped.push({ detector, path, reason });
  }

  /**
   * Close the run. A candidate inside another one is dropped (and recorded as skipped); the rest
   * are ordered by size, largest first, then path; at most `maxCandidates` are listed.
   */
  close(maxCandidates: number): FindingsSummary {
    const byDepth = [...this.candidates].sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
    const kept: FsFinding[] = [];
    for (const c of byDepth) {
      if (kept.some((k) => isInside(k.path, c.path))) {
        this.skip(c.detector, c.path, "inside another candidate");
        continue;
      }
      kept.push(c);
    }
    kept.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
    let listed = kept;
    if (kept.length > maxCandidates) {
      this.warn(`more than ${maxCandidates} candidates found; only the largest are listed`);
      listed = kept.slice(0, maxCandidates);
    }
    return { fs: listed, reports: this.reports, skipped: this.skipped, skippedCount: this.skippedCount, warnings: this.warnings };
  }
}
