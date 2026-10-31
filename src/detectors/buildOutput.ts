import { join } from "node:path";
import { lstatOrNull } from "../fsapi.js";
import { hasTrackedFiles, isIgnored, repoInfo } from "../git.js";
import { isInside } from "../paths.js";
import { evaluateFsCandidate, skip, type ScanCtx } from "./common.js";

interface BuildSpec {
  /** Path segments below the project directory. */
  rel: string[];
  /** Any of these regular files next to it identifies the project type (needed when there is no git). */
  manifests: string[];
  /** For Python caches a sibling .py file also identifies the project type. */
  pySibling?: boolean;
  regenerate: string;
}

export const BUILD_OUTPUTS: BuildSpec[] = [
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

/** First path segment of every build output, used by the scanner to know which names to look at. */
export const BUILD_FIRST_SEGMENTS = new Set(BUILD_OUTPUTS.map((b) => b.rel[0] as string));

async function realDir(ctx: ScanCtx, path: string): Promise<boolean> {
  const st = await lstatOrNull(ctx.deps.fs, path);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

async function hasManifest(ctx: ScanCtx, dir: string, spec: BuildSpec, names: ReadonlySet<string>): Promise<string | null> {
  for (const m of spec.manifests) {
    if (!names.has(m)) continue;
    const st = await lstatOrNull(ctx.deps.fs, join(dir, m));
    if (st && st.isFile()) return m;
  }
  if (spec.pySibling) {
    for (const n of names) {
      if (!n.endsWith(".py")) continue;
      const st = await lstatOrNull(ctx.deps.fs, join(dir, n));
      if (st && st.isFile()) return n;
    }
  }
  return null;
}

/**
 * Build outputs and tool caches from a fixed allowlist of names. Eligible when the directory is
 * git-ignored and holds no tracked files, or (no git) the name is on the allowlist and a sibling
 * manifest identifies the project type. Returns the full paths that were accepted.
 */
export async function evaluateBuildOutputs(
  ctx: ScanCtx,
  dir: string,
  names: ReadonlySet<string>,
  root: string,
  rootDev: bigint,
): Promise<string[]> {
  const { deps, config } = ctx;
  const accepted: string[] = [];
  let repo: Awaited<ReturnType<typeof repoInfo>> | undefined;
  for (const spec of BUILD_OUTPUTS) {
    if (!names.has(spec.rel[0] as string)) continue;
    // every segment between the project and the output must be a real directory
    let path = dir;
    let ok = true;
    for (const seg of spec.rel) {
      path = join(path, seg);
      if (!(await realDir(ctx, path))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    repo ??= await repoInfo(deps, dir, root);
    let why: string;
    if (repo.state === "unavailable") {
      skip(ctx, "build-output", path, "inside a git repository but git state could not be read");
      continue;
    }
    if (repo.state === "repo") {
      if (!isInside(root, repo.toplevel)) {
        skip(ctx, "build-output", path, "its git repository root is outside the configured root");
        continue;
      }
      const ignored = await isIgnored(deps, dir, path);
      if (ignored !== "ignored") {
        skip(ctx, "build-output", path, ignored === "error" ? "git check-ignore failed" : "not git-ignored");
        continue;
      }
      const tracked = await hasTrackedFiles(deps, dir, path);
      if (tracked !== false) {
        skip(ctx, "build-output", path, tracked === "error" ? "git ls-files failed" : "contains files tracked by git");
        continue;
      }
      why = "git-ignored and untracked";
    } else {
      const manifest = await hasManifest(ctx, dir, spec, names);
      if (!manifest) {
        skip(ctx, "build-output", path, "no sibling manifest identifies the project type");
        continue;
      }
      why = `allowlisted name next to ${manifest} (no git repository)`;
    }
    const label = spec.rel.join("/");
    const ok2 = await evaluateFsCandidate(ctx, {
      detector: "build-output",
      path,
      baseDev: rootDev,
      strict: true,
      activityMs: 0,
      minAgeDays: config.buildMinAgeDays,
      reasonFor: (age) => `build output ${label}, nothing inside modified for ${age} days; ${why}`,
      regenerate: spec.regenerate,
    });
    if (ok2) accepted.push(path);
  }
  return accepted;
}
