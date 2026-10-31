import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function snapshot(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      h.update(`${p}\0${st.mode}\0${st.size}\0`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

/**
 * Per-run setup:
 *  - a sentinel fake HOME holding tripwire files. Every test process gets HOME pointed at it, so
 *    code that wrongly falls back to the home directory hits the tripwire instead of a real one.
 *    After the whole suite the tripwire tree must be byte-for-byte unchanged.
 *  - a compiled copy of the sources for the tests that spawn the real CLI and MCP binaries.
 */
export default function setup(): () => void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dj-sentinel-")));
  const home = join(base, "home");
  const trip = {
    documents: join(home, "Documents", "tripwire.txt"),
    ssh: join(home, ".ssh", "id_tripwire"),
    project: join(home, "projects", "decoy", "node_modules", "decoy.txt"),
  };
  for (const p of Object.values(trip)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `tripwire ${p}\n`);
  }
  const before = snapshot(home);

  const distDir = join(repo, `.test-dist-${process.pid}`);
  execFileSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", distDir, "--sourceMap", "false", "--declaration", "false"], {
    cwd: repo,
    stdio: "inherit",
  });

  process.env["DJ_SENTINEL_HOME"] = home;
  process.env["DJ_TEST_DIST"] = distDir;

  return () => {
    rmSync(distDir, { recursive: true, force: true });
    const after = snapshot(home);
    const ok = after === before;
    rmSync(base, { recursive: true, force: true });
    if (!ok) throw new Error("SENTINEL VIOLATION: the tripwire home directory was modified by the test suite");
  };
}
