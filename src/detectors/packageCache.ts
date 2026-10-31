import { join } from "node:path";
import { lstatOrNull } from "../fsapi.js";
import { findSymlinkInChain } from "../paths.js";
import { evaluateFsCandidate, skip, type ScanCtx } from "./common.js";

export interface CacheLocation {
  id: string;
  label: string;
  /** Path segments below the home directory. Only these exact locations are ever considered. */
  rel: string[];
  regenerate: string;
}

/** Documented default locations of package-manager caches. Nothing else is considered. */
export const CACHE_LOCATIONS: CacheLocation[] = [
  { id: "npm", label: "npm cache", rel: [".npm", "_cacache"], regenerate: "npm re-downloads packages on demand" },
  { id: "pnpm-linux", label: "pnpm store", rel: [".local", "share", "pnpm", "store"], regenerate: "pnpm install re-fetches packages" },
  { id: "pnpm-macos", label: "pnpm store", rel: ["Library", "pnpm", "store"], regenerate: "pnpm install re-fetches packages" },
  { id: "yarn-linux", label: "yarn cache", rel: [".cache", "yarn"], regenerate: "yarn re-downloads packages on demand" },
  { id: "yarn-macos", label: "yarn cache", rel: ["Library", "Caches", "Yarn"], regenerate: "yarn re-downloads packages on demand" },
  { id: "yarn-berry", label: "yarn berry global cache", rel: [".yarn", "berry", "cache"], regenerate: "yarn install re-downloads packages" },
  { id: "pip-linux", label: "pip cache", rel: [".cache", "pip"], regenerate: "pip re-downloads wheels on demand" },
  { id: "pip-macos", label: "pip cache", rel: ["Library", "Caches", "pip"], regenerate: "pip re-downloads wheels on demand" },
  { id: "cargo", label: "cargo registry cache", rel: [".cargo", "registry", "cache"], regenerate: "cargo re-downloads crates on demand" },
  { id: "brew-macos", label: "Homebrew downloads", rel: ["Library", "Caches", "Homebrew", "downloads"], regenerate: "brew re-downloads bottles on demand" },
  { id: "brew-linux", label: "Homebrew downloads", rel: [".cache", "Homebrew", "downloads"], regenerate: "brew re-downloads bottles on demand" },
  { id: "gradle", label: "Gradle caches", rel: [".gradle", "caches"], regenerate: "Gradle re-downloads dependencies on the next build" },
];

export function cachePaths(home: string): string[] {
  return CACHE_LOCATIONS.map((c) => join(home, ...c.rel));
}

export async function scanPackageCaches(ctx: ScanCtx): Promise<void> {
  const { deps, config } = ctx;
  const homeStat = await lstatOrNull(deps.fs, config.home);
  if (!homeStat) {
    ctx.warnings.push("home directory does not exist; package caches not scanned");
    return;
  }
  for (const loc of CACHE_LOCATIONS) {
    const path = join(config.home, ...loc.rel);
    const st = await lstatOrNull(deps.fs, path);
    if (!st) continue;
    const link = await findSymlinkInChain(deps.fs, path, true).catch(() => path);
    if (link) {
      skip(ctx, "package-cache", path, "a path component is a symlink (never followed)");
      continue;
    }
    await evaluateFsCandidate(ctx, {
      detector: "package-cache",
      path,
      baseDev: homeStat.dev,
      strict: false,
      activityMs: 0,
      minAgeDays: config.cacheMinAgeDays,
      reasonFor: (age) => `${loc.label} at its default location, nothing inside modified for ${age} days`,
      regenerate: loc.regenerate,
    });
  }
}
