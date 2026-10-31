import { utimesSync } from "node:fs";
import type { RawConfig } from "../src/config.js";
import type { Deps } from "../src/composition/deps.js";
import type { FileSystem } from "../src/application/ports/common.js";
import { scan, type ScanResult } from "../src/scan.js";
import type { Config } from "../src/config.js";
import { DAY, makeConfig, testDeps, type FakeRun, type Sandbox } from "./helpers.js";

export type TestDeps = Deps & { calls: FakeRun["calls"] };

export interface Scanned {
  config: Config;
  deps: TestDeps;
  result: ScanResult;
}

/** Resolve a config for the sandbox and run a scan. */
export async function scanFor(sb: Sandbox, overrides: RawConfig = {}, deps: TestDeps = testDeps()): Promise<Scanned> {
  const config = await makeConfig(sb, overrides, deps);
  const result = await scan(config, deps);
  return { config, deps, result };
}

/** Set mtime/atime of exactly one path to `days` days ago. */
export function touch(path: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

export function candidatePaths(result: ScanResult): string[] {
  return result.fs.map((c) => c.path).sort();
}

export function skippedFor(result: ScanResult, path: string): string[] {
  return result.skipped.filter((s) => s.path === path).map((s) => s.reason);
}

/** Wrap the real fs so every lstat/readdir/realpath path is recorded. */
export function recordingFs(base: FileSystem, seen: string[]): FileSystem {
  return {
    lstat: (p) => {
      seen.push(p);
      return base.lstat(p);
    },
    readdir: (p) => {
      seen.push(p);
      return base.readdir(p);
    },
    realpath: (p) => {
      seen.push(p);
      return base.realpath(p);
    },
    rename: (a, b) => base.rename(a, b),
  };
}

export type { Deps };
