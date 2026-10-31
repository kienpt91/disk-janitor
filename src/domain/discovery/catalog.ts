// The fixed catalogue of what discovery may ever look at. Nothing outside these lists is a
// Candidate: lockfiles that make a reinstall reproducible, build output names, package-manager
// cache locations and the only docker commands this tool sends.

import { join } from "node:path";

/** A lockfile that makes `node_modules` reproducible, with the command that restores it. */
export interface Lockfile {
  name: string;
  regenerate: string;
}

/** In order of preference: the first one found names the reinstall command. */
export const LOCKFILES: readonly Lockfile[] = [
  { name: "package-lock.json", regenerate: "npm ci" },
  { name: "npm-shrinkwrap.json", regenerate: "npm ci" },
  { name: "yarn.lock", regenerate: "yarn install --frozen-lockfile" },
  { name: "pnpm-lock.yaml", regenerate: "pnpm install --frozen-lockfile" },
  { name: "bun.lock", regenerate: "bun install --frozen-lockfile" },
  { name: "bun.lockb", regenerate: "bun install --frozen-lockfile" },
];

export interface BuildOutputSpec {
  /** Path segments below the project directory. */
  rel: readonly string[];
  /** Any of these regular files next to it identifies the project type (needed when there is no git). */
  manifests: readonly string[];
  /** For Python caches a sibling .py file also identifies the project type. */
  pySibling?: boolean;
  regenerate: string;
}

export const BUILD_OUTPUTS: readonly BuildOutputSpec[] = [
  { rel: [".next"], manifests: ["package.json"], regenerate: "next build" },
  { rel: ["dist"], manifests: ["package.json", "pyproject.toml", "setup.py", "setup.cfg"], regenerate: "run the project's build (for example npm run build)" },
  {
    rel: ["build"],
    manifests: ["package.json", "pyproject.toml", "setup.py", "CMakeLists.txt", "build.gradle", "build.gradle.kts"],
    regenerate: "run the project's build",
  },
  { rel: ["target"], manifests: ["Cargo.toml", "pom.xml"], regenerate: "cargo build or mvn package" },
  { rel: [".turbo"], manifests: ["package.json", "turbo.json"], regenerate: "turbo run build (cache refills automatically)" },
  { rel: [".cache", "vite"], manifests: ["package.json"], regenerate: "vite (cache refills automatically)" },
  { rel: ["__pycache__"], manifests: [], pySibling: true, regenerate: "python recompiles bytecode on import" },
  {
    rel: [".pytest_cache"],
    manifests: ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "requirements.txt"],
    pySibling: true,
    regenerate: "pytest recreates it",
  },
  {
    rel: [".mypy_cache"],
    manifests: ["pyproject.toml", "setup.py", "setup.cfg", "mypy.ini", "requirements.txt"],
    pySibling: true,
    regenerate: "mypy recreates it",
  },
  { rel: ["coverage"], manifests: ["package.json", "pyproject.toml", "setup.py"], regenerate: "re-run the test suite with coverage" },
];

/** First path segment of every build output, used by the walk to know which names to look at. */
export const BUILD_FIRST_SEGMENTS: ReadonlySet<string> = new Set(BUILD_OUTPUTS.map((b) => b.rel[0] as string));

export interface CacheLocation {
  id: string;
  label: string;
  /** Path segments below the home directory. Only these exact locations are ever considered. */
  rel: readonly string[];
  regenerate: string;
}

/** Documented default locations of package-manager caches. Nothing else is considered. */
export const CACHE_LOCATIONS: readonly CacheLocation[] = [
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

/**
 * The only commands this tool ever sends to the docker CLI. Fixed argument lists: no volumes, no
 * running containers, no `-a`/`--all` image removal, nothing built from plan or user input.
 */
export const DOCKER_COMMANDS = {
  df: ["system", "df", "--format", "{{json .}}"],
  danglingImages: ["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"],
  pruneBuildCache: ["builder", "prune", "--force"],
  pruneDanglingImages: ["image", "prune", "--force"],
} as const;
