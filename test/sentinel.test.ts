import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStateDir } from "../src/domain/model/config.js";
import { resolveConfig } from "../src/composition/planning.js";
import { RootsError } from "../src/domain/policy/roots.js";
import { makeProject, makeSandbox, testDeps, treeHash } from "./helpers.js";
import { baseArgs, cli, cliApprove, cliPlan } from "./helpers-cli.js";

const SENTINEL = process.env["DJ_SENTINEL_HOME"] as string; // set by global setup; asserted below
const TRIPWIRES = {
  documents: join(SENTINEL, "Documents", "tripwire.txt"),
  ssh: join(SENTINEL, ".ssh", "id_tripwire"),
  decoy: join(SENTINEL, "projects", "decoy", "node_modules", "decoy.txt"),
};
const BEFORE = treeHash(SENTINEL);

function expectTripwiresIntact(): void {
  for (const p of Object.values(TRIPWIRES)) expect(readFileSync(p, "utf8")).toBe(`tripwire ${p}\n`);
  expect(treeHash(SENTINEL)).toBe(BEFORE);
}

describe("sentinel: the test process never sees a real home", () => {
  it("HOME and os.homedir() are the sentinel", () => {
    expect(SENTINEL).toBeTruthy();
    expect(process.env["HOME"]).toBe(SENTINEL);
    expect(homedir()).toBe(SENTINEL);
  });

  it("XDG_STATE_HOME points below the sentinel and agent markers are cleared", () => {
    expect(process.env["XDG_STATE_HOME"]).toBe(join(SENTINEL, ".local", "state"));
    for (const name of ["CI", "DISK_JANITOR_AGENT", "DISK_JANITOR_NONINTERACTIVE", "AGENT_SESSION", "NONINTERACTIVE"]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it("the tripwire files exist with their original content", () => {
    for (const p of Object.values(TRIPWIRES)) {
      expect(existsSync(p), p).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(`tripwire ${p}\n`);
    }
    expect(readdirSync(SENTINEL).sort()).toEqual([".ssh", "Documents", "projects"]);
  });
});

describe("sentinel: default home and state resolution never reach the tripwires", () => {
  it("a scan with the process environment (default state resolution) is read-only", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "app"), { nodeModules: 4000 });
    const r = await cli(sb, ["scan", "--root", sb.projects, "--home", sb.home, "--min-size", "1"], testDeps(), { env: { ...process.env } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(sb.projects, "app", "node_modules"));
    expectTripwiresIntact();
    expect(existsSync(join(SENTINEL, ".local"))).toBe(false);
  });

  it("with XDG_STATE_HOME set, state defaults to $XDG_STATE_HOME/disk-janitor and the full cycle works", async () => {
    const sb = makeSandbox();
    const xdg = join(sb.base, "xdg");
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 4000 });
    const before = treeHash(app);
    const env = { XDG_STATE_HOME: xdg };
    const flags = ["--root", sb.projects, "--home", sb.home, "--min-size", "1"];
    const planned = await cli(sb, ["plan", ...flags], testDeps(), { env });
    expect(planned.code).toBe(0);
    const id = /plan:\s+(plan-\S+)/.exec(planned.out)?.[1] ?? "";
    const digest = /digest:\s+([0-9a-f]{64})/.exec(planned.out)?.[1] ?? "";
    expect(existsSync(join(xdg, "disk-janitor", "plans", `${id}.json`))).toBe(true);
    const approved = await cli(sb, ["approve", id, "--home", sb.home], testDeps(), { env, tty: true, answers: [digest.slice(0, 8)] });
    expect(approved.code).toBe(0);
    const applied = await cli(sb, ["apply", id, ...flags], testDeps(), { env });
    expect(applied.code).toBe(0);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    const restored = await cli(sb, ["restore", id, "--home", sb.home], testDeps(), { env });
    expect(restored.code).toBe(0);
    expect(treeHash(app)).toBe(before);
    expectTripwiresIntact();
  });

  it("without XDG_STATE_HOME the state lives under the given home, not the process home", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "app"), { nodeModules: 4000 });
    const r = await cli(sb, ["plan", "--root", sb.projects, "--home", sb.home, "--min-size", "1"], testDeps(), { env: {} });
    expect(r.code).toBe(0);
    const stateDir = join(sb.home, ".local", "state", "disk-janitor");
    expect(readdirSync(join(stateDir, "plans"))).toHaveLength(1);
    expectTripwiresIntact();
    expect(existsSync(join(SENTINEL, ".local"))).toBe(false);
  });

  it("defaultStateDir honours an absolute XDG_STATE_HOME and ignores a relative one", () => {
    expect(defaultStateDir("/h", { XDG_STATE_HOME: "/x/state" })).toBe("/x/state/disk-janitor");
    expect(defaultStateDir("/h", { XDG_STATE_HOME: "relative/dir" })).toBe("/h/.local/state/disk-janitor");
    expect(defaultStateDir("/h", {})).toBe("/h/.local/state/disk-janitor");
    expect(defaultStateDir(SENTINEL, process.env)).toBe(join(SENTINEL, ".local", "state", "disk-janitor"));
  });

  it("an explicit state dir keeps the sentinel untouched for a full plan/approve/apply flow", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 4000 });
    const p = await cliPlan(sb);
    expect((await cliApprove(sb, p)).code).toBe(0);
    expect((await cli(sb, ["apply", p.id, ...baseArgs(sb)])).code).toBe(0);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    expectTripwiresIntact();
  });

  it("scanning a root inside the sentinel home changes nothing and does not offer the decoy", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", "--root", join(SENTINEL, "projects"), "--home", SENTINEL, "--min-size", "1", "--json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { candidates: unknown[] };
    expect(data.candidates).toEqual([]);
    expectTripwiresIntact();
  });
});

describe("sentinel: the home directory can never be a root", () => {
  it("resolveConfig refuses the sentinel home with RootsError", async () => {
    await expect(resolveConfig({ roots: [SENTINEL] }, testDeps(), { env: {} })).rejects.toBeInstanceOf(RootsError);
    await expect(resolveConfig({ roots: [SENTINEL] }, testDeps(), { env: {} })).rejects.toThrow(/home directory/);
  });

  it("refuses the sentinel home even when another home is configured", async () => {
    const sb = makeSandbox();
    await expect(resolveConfig({ roots: [SENTINEL], home: sb.home }, testDeps(), { env: {} })).rejects.toBeInstanceOf(RootsError);
  });

  it("refuses a root that contains the sentinel home", async () => {
    const sb = makeSandbox();
    await expect(resolveConfig({ roots: [join(SENTINEL, "..")], home: sb.home }, testDeps(), { env: {} })).rejects.toBeInstanceOf(RootsError);
  });

  it("the CLI exits 1 for scan and plan with --root on the sentinel home", async () => {
    const sb = makeSandbox();
    for (const cmd of ["scan", "plan"]) {
      const r = await cli(sb, [cmd, "--root", SENTINEL, "--state-dir", sb.state]);
      expect(r.code, cmd).toBe(1);
      expect(r.err, cmd).toContain("home directory");
    }
    expect(existsSync(sb.state)).toBe(false);
    expectTripwiresIntact();
  });

  it("a root given as a symlink to the sentinel home is refused as well", async () => {
    const sb = makeSandbox();
    const link = join(sb.base, "homelink");
    symlinkSync(SENTINEL, link);
    const r = await cli(sb, ["scan", "--root", link, "--home", sb.home, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expectTripwiresIntact();
  });
});
