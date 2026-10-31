// Apply-time catalogue check: is a file-system Candidate of a Plan really one of the things
// discovery may offer? A Plan is a document; a forged one (valid digest, approved by a human who
// only skimmed it) can name any directory under a root. Apply therefore re-derives, from the
// catalogue alone, what a Candidate of its detector must look like and compares it with facts
// observed just now. What is NOT re-run at apply: git ignore state and tracked files (they need
// the git CLI); a `.git` entry stands in for "this is a repository" where discovery would have asked git.

import { basename, dirname, join } from "node:path";
import type { ConfigCore, FsCandidate } from "../model/types.js";
import { baseFor } from "../policy/bases.js";
import { isInside } from "../shared/paths.js";
import { BUILD_OUTPUTS, LOCKFILES, cachePaths, type BuildOutputSpec } from "./catalog.js";

export type CatalogConfig = Pick<ConfigCore, "roots" | "home" | "detectors">;

/** What must be observed to judge a Candidate; `files` are names to lstat in `projectDir`. */
export type CatalogExpectation =
  | { kind: "refused"; reason: string }
  | { kind: "exact" }
  | { kind: "node-modules"; projectDir: string; files: string[] }
  | { kind: "build-output"; spec: BuildOutputSpec; projectDir: string; files: string[]; pythonSource: boolean; gitDirs: string[] };

/** Observations in the project directory (all via lstat, never following links). */
export interface CatalogFacts {
  /** Those of the expected `files` that exist as regular files. */
  regularFiles: ReadonlySet<string>;
  /** A regular file named *.py exists in the project directory. */
  pythonSource: boolean;
  /** A `.git` entry (directory or file) exists in any of the expected `gitDirs`. */
  gitEntry: boolean;
}

const refused = (reason: string): CatalogExpectation => ({ kind: "refused", reason });
const NOT_BUILD_OUTPUT = "its path below the project directory is not a catalogued build output";
const OUTSIDE_ROOT = "its project directory is outside the configured root";

/** Directories from `from` up to and including `root`. */
function chainUpTo(from: string, root: string): string[] {
  const out: string[] = [];
  for (let d = from; isInside(root, d); d = dirname(d)) {
    out.push(d);
    if (d === root || dirname(d) === d) break;
  }
  return out;
}

function matchBuildOutput(path: string): { spec: BuildOutputSpec; projectDir: string } | null {
  for (const spec of BUILD_OUTPUTS) {
    const suffix = join(...spec.rel);
    if (!path.endsWith("/" + suffix)) continue;
    const projectDir = path.slice(0, path.length - suffix.length - 1) || "/";
    return { spec, projectDir };
  }
  return null;
}

/** What apply expects of `candidate`, from the catalogue and the configuration alone. */
export function expectedCatalogItem(config: CatalogConfig, candidate: Pick<FsCandidate, "detector" | "path">): CatalogExpectation {
  const { detector, path } = candidate;
  switch (detector) {
    case "node-modules": {
      if (basename(path) !== "node_modules") return refused("its name is not node_modules");
      const projectDir = dirname(path);
      const root = baseFor(config, projectDir)?.dir;
      if (!root || !isInside(root, projectDir)) return refused(OUTSIDE_ROOT);
      return { kind: "node-modules", projectDir, files: ["package.json", ...LOCKFILES.map((l) => l.name)] };
    }
    case "build-output": {
      const m = matchBuildOutput(path);
      if (!m) return refused(NOT_BUILD_OUTPUT);
      const root = config.roots.find((r) => isInside(r, m.projectDir));
      if (!root) return refused(OUTSIDE_ROOT);
      return {
        kind: "build-output",
        spec: m.spec,
        projectDir: m.projectDir,
        files: [...m.spec.manifests],
        pythonSource: m.spec.pySibling === true,
        gitDirs: chainUpTo(m.projectDir, root),
      };
    }
    case "package-cache":
      if (!config.detectors.includes("package-cache")) return refused("the package-cache detector is not enabled");
      return cachePaths(config.home).includes(path) ? { kind: "exact" } : refused("it is not one of the documented package-manager cache locations");
    default:
      return refused(`detector ${detector} does not produce file-system candidates`);
  }
}

/** Why the observed facts do not identify a catalogue item, or null when they do. */
export function catalogFactsRefusal(expectation: Exclude<CatalogExpectation, { kind: "refused" }>, facts: CatalogFacts): string | null {
  switch (expectation.kind) {
    case "exact":
      return null;
    case "node-modules":
      if (!facts.regularFiles.has("package.json")) return "no package.json next to it, so it is not a recognised project";
      if (!LOCKFILES.some((l) => facts.regularFiles.has(l.name))) return "no lockfile next to it, so the install is not reproducible";
      return null;
    case "build-output":
      if (expectation.spec.manifests.some((m) => facts.regularFiles.has(m))) return null;
      if (expectation.pythonSource && facts.pythonSource) return null;
      if (facts.gitEntry) return null;
      return "no sibling manifest identifies the project type and no .git entry was found (git ignore state is not re-checked at apply)";
  }
}
