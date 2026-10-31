import { resolve } from "node:path";
import { buildConfig, defaultStateDir, type Config, type RawConfig } from "../domain/model/config.js";
import type { FileSystem } from "./ports/common.js";
import { validateRoots } from "./validate-roots.js";

export interface ResolveOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The invoking user's home directory (os.homedir()), always treated as protected. */
  homeDir: string;
}

/**
 * Turn user input into a validated configuration: roots are canonicalized and checked, the
 * home directory is canonicalized, thresholds are range-checked and the digest computed.
 */
export async function resolveConfig(raw: RawConfig, deps: { fs: FileSystem }, opts: ResolveOptions): Promise<Config> {
  const homeInput = raw.home ? resolve(opts.cwd, raw.home) : opts.homeDir;
  let home: string;
  try {
    home = await deps.fs.realpath(homeInput);
  } catch {
    throw new Error(`home directory does not exist: ${homeInput}`);
  }
  const homes = [...new Set([home, opts.homeDir])];
  const roots = await validateRoots(raw.roots ?? [], { homes, fs: deps.fs, cwd: opts.cwd });
  const stateDir = raw.stateDir ? resolve(opts.cwd, raw.stateDir) : defaultStateDir(home, opts.env);
  return buildConfig(raw, { roots, home, stateDir });
}
