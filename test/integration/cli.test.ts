import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ENV_MARKERS } from "../../src/domain/policy/human.js";
import { acquireLock } from "../../src/infrastructure/fs/file-lock.js";
import { purgeCandidates, purgeSetDigest } from "../../src/composition/disposal.js";
import { DAY, makeProject, makeSandbox, testDeps, treeHash, writeText, type Sandbox } from "../support/helpers.js";
import { approvalFiles, auditEvents, baseArgs, cli, cliApprove, cliPlan, stateOf, tamperFile } from "../support/helpers-cli.js";

function clockDeps() {
  const clock = { t: Date.now() };
  return { clock, deps: testDeps({ now: () => clock.t }) };
}

function oneProject(sb: Sandbox, name = "app"): string {
  return makeProject(join(sb.projects, name), { nodeModules: 5000 });
}

describe("cli: usage errors", () => {
  it("exits 2 on an unknown command and prints help on stderr", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command frobnicate");
    expect(r.err).toContain("usage: disk-janitor");
  });

  it("exits 2 on an unknown flag", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", "--no-such-flag"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--no-such-flag");
  });

  it("exits 2 when no command is given", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, []);
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage: disk-janitor");
  });

  it.each([
    ["explain", "plan is required"],
    ["restore", "plan id or path is required"],
    ["apply", "plan is required"],
  ])("exits 2 when %s has no positional argument", async (cmd, message) => {
    const sb = makeSandbox();
    const r = await cli(sb, [cmd, "--state-dir", sb.state, "--home", sb.home, "--root", sb.projects]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("exits 2 when approve has no plan argument (human session satisfied)", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["approve", "--state-dir", sb.state], testDeps(), { tty: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("plan is required");
  });

  it.each(["abc", "1.5", "12x", ""])("exits 2 for --stale-days %j", async (value) => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", ...baseArgs(sb), "--stale-days", value]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--stale-days expects a non-negative integer");
  });

  it("--help exits 0 and lists every command", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["--help"]);
    expect(r.code).toBe(0);
    for (const word of ["scan", "plan", "explain", "approve", "apply", "restore", "purge", "status", "audit", "doctor"]) {
      expect(r.out).toContain(`  ${word} `);
    }
    expect(r.err).toBe("");
  });

  it("-h after a command also exits 0", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", "-h"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: disk-janitor");
  });
});

describe("cli: scan", () => {
  it("lists candidates with why/regenerate lines and says nothing was changed", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const before = treeHash(sb.projects);
    const r = await cli(sb, ["scan", ...baseArgs(sb)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing was changed");
    expect(r.out).toContain(join(app, "node_modules"));
    expect(r.out).toContain("why:");
    expect(r.out).toContain("regenerate:");
    expect(r.out).toContain("total reclaimable");
    expect(treeHash(sb.projects)).toBe(before);
  });

  it("scan --json parses and contains the candidate", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const r = await cli(sb, ["scan", "--json", ...baseArgs(sb)]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as { roots: string[]; candidates: Array<{ path: string; detector: string; size: number }> };
    expect(data.roots).toEqual([sb.projects]);
    expect(data.candidates.map((c) => c.path)).toEqual([join(app, "node_modules")]);
    expect(data.candidates[0]?.detector).toBe("node-modules");
  });

  it("without --root fails with the 'no roots' message and creates no state directory", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const r = await cli(sb, ["scan", "--home", sb.home, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no roots configured");
    expect(existsSync(sb.state)).toBe(false);
  });

  it("refuses '/' as a root", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", "--root", "/", "--home", sb.home, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing");
    expect(existsSync(sb.state)).toBe(false);
  });

  it("refuses the home directory as a root", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["scan", "--root", sb.home, "--home", sb.home, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("home directory");
  });

  it("scan --verbose lists skipped paths with reasons", async () => {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "fresh"), { ageDays: 1 });
    const plain = await cli(sb, ["scan", ...baseArgs(sb)]);
    expect(plain.out).toContain("use --verbose");
    const r = await cli(sb, ["scan", "--verbose", ...baseArgs(sb)]);
    expect(r.out).toContain("listed below");
    expect(r.out).toContain(join(sb.projects, "fresh", "node_modules"));
  });

  it("reports the open-file check as not performed when lsof is missing", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const r = await cli(sb, ["scan", ...baseArgs(sb)], testDeps());
    expect(r.out).toContain("open-file check: NOT performed");
  });
});

describe("cli: plan and explain", () => {
  it("writes a 0600 plan file in the state dir, prints id and digest, creates no quarantine", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const before = treeHash(app);
    const p = await cliPlan(sb);
    expect(statSync(p.file).mode & 0o777).toBe(0o600);
    expect(p.id).toMatch(/^plan-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.plan.candidates.map((c) => (c.kind === "fs" ? c.path : ""))).toEqual([join(app, "node_modules")]);
    expect(readdirSync(join(sb.state, "quarantine"))).toEqual([]);
    expect(treeHash(app)).toBe(before);
    expect(auditEvents(sb)).toEqual(["plan-created"]);
  });

  it("prints the id, the digest and the next steps", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const r = await cli(sb, ["plan", ...baseArgs(sb)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/digest:\s+[0-9a-f]{64}/);
    expect(r.out).toContain("nothing was changed");
    expect(r.out).toMatch(/disk-janitor approve plan-/);
  });

  it("--out writes the plan elsewhere and explain accepts that path", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const out = join(sb.base, "my-plan.json");
    const r = await cli(sb, ["plan", ...baseArgs(sb), "--out", out]);
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(sb.state, "plans"))).toEqual([]);
    expect(r.out).toContain(out);
    const e = await cli(sb, ["explain", out, "--state-dir", sb.state]);
    expect(e.code).toBe(0);
    expect(e.out).toContain("digest check: OK");
  });

  it("explain by id verifies the digest and shows each candidate", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const p = await cliPlan(sb);
    const r = await cli(sb, ["explain", p.id, "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("digest check: OK");
    expect(r.out).toContain(join(app, "node_modules"));
    expect(r.out).toContain("apply will: re-validate");
  });

  it("explain fails with exit 1 on a tampered plan file", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    tamperFile(p.file, /"size": \d+/, '"size": 1');
    const r = await cli(sb, ["explain", p.id, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plan digest mismatch");
    expect(r.out).not.toContain("digest check: OK");
  });

  it("explain fails for a plan id that does not exist", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["explain", "plan-20260101T000000Z-00000000", "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ENOENT");
  });
});

describe("cli: approve (human only)", () => {
  async function planned() {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const { clock, deps } = clockDeps();
    const p = await cliPlan(sb, deps);
    return { sb, app, clock, deps, p };
  }

  it("refuses when stdin is not a TTY", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { stdinIsTTY: false, stdoutIsTTY: true, answers: [p.digest] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("non-interactive");
    expect(r.io.asked).toEqual([]);
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("refuses when stdout is not a TTY", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { stdinIsTTY: true, stdoutIsTTY: false, answers: [p.digest] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("non-interactive");
    expect(approvalFiles(sb)).toEqual([]);
  });

  it.each([...AGENT_ENV_MARKERS])("refuses while %s is set", async (marker) => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { tty: true, env: { [marker]: "1" }, answers: [p.digest.slice(0, 8)] });
    expect(r.code).toBe(1);
    expect(r.err).toContain(marker);
    expect(r.io.asked).toEqual([]);
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("a falsy marker value (CI=0) does not block a human", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { tty: true, env: { CI: "0" }, answers: [p.digest] });
    expect(r.code).toBe(0);
    expect(approvalFiles(sb)).toEqual([`${p.digest}.json`]);
  });

  it("a wrong digest typed exits 1, writes no approval and logs approval-declined", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { tty: true, answers: ["deadbeef"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not approved");
    expect(approvalFiles(sb)).toEqual([]);
    expect(auditEvents(sb)).toEqual(["plan-created", "approval-declined"]);
  });

  it("asks for the full digest without printing it, and the approve screen never shows it", async () => {
    const { sb, deps, p } = await planned();
    const r = await cliApprove(sb, p, deps);
    expect(r.code).toBe(0);
    expect(r.io.asked).toHaveLength(1);
    expect(r.io.asked[0]).toContain("full plan digest");
    expect(r.io.asked[0]).toContain("disk-janitor explain");
    expect(r.io.asked[0]).not.toContain(p.digest.slice(0, 8));
    expect(r.out).not.toContain(p.digest.slice(0, 8));
    expect(r.out).toContain(p.id);
  });

  it("the old 8-character prefix is not accepted", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["approve", p.id, "--state-dir", sb.state], deps, { tty: true, answers: [p.digest.slice(0, 8)] });
    expect(r.code).toBe(1);
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("explain shows the full digest the human has to type", async () => {
    const { sb, deps, p } = await planned();
    const r = await cli(sb, ["explain", p.id, "--state-dir", sb.state], deps);
    expect(r.out).toContain(p.digest);
  });

  it("typing the full digest writes the approval file and apply then succeeds", async () => {
    const { sb, app, deps, p } = await planned();
    const r = await cliApprove(sb, p, deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("approved until");
    expect(approvalFiles(sb)).toEqual([`${p.digest}.json`]);
    expect(statSync(join(sb.state, "approvals", `${p.digest}.json`)).mode & 0o777).toBe(0o600);
    const a = await cli(sb, ["apply", p.id, ...baseArgs(sb)], deps);
    expect(a.code).toBe(0);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
  });

  it("approve itself never applies: nothing moves and no apply event is logged", async () => {
    const { sb, app, deps, p } = await planned();
    const before = treeHash(app);
    const r = await cliApprove(sb, p, deps);
    expect(r.code).toBe(0);
    expect(treeHash(app)).toBe(before);
    expect(readdirSync(join(sb.state, "quarantine"))).toEqual([]);
    expect(auditEvents(sb)).toEqual(["plan-created", "approval-issued"]);
  });

  it("--minutes 5 sets a 5 minute expiry", async () => {
    const { sb, clock, deps, p } = await planned();
    const r = await cliApprove(sb, p, deps, ["--minutes", "5"]);
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(join(sb.state, "approvals", `${p.digest}.json`), "utf8")) as { issuedAt: number; expiresAt: number };
    expect(rec.issuedAt).toBe(clock.t);
    expect(rec.expiresAt - rec.issuedAt).toBe(5 * 60_000);
  });

  it("the default validity is 15 minutes", async () => {
    const { sb, deps, p } = await planned();
    await cliApprove(sb, p, deps);
    const rec = JSON.parse(readFileSync(join(sb.state, "approvals", `${p.digest}.json`), "utf8")) as { issuedAt: number; expiresAt: number };
    expect(rec.expiresAt - rec.issuedAt).toBe(15 * 60_000);
  });

  it.each(["61", "0", "abc"])("--minutes %s is a usage error and writes nothing", async (minutes) => {
    const { sb, deps, p } = await planned();
    const r = await cliApprove(sb, p, deps, ["--minutes", minutes]);
    expect(r.code).toBe(2);
    expect(r.io.asked).toEqual([]);
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("refuses to approve a plan older than 24 hours", async () => {
    const { sb, clock, deps, p } = await planned();
    clock.t += 25 * 3_600_000;
    const r = await cliApprove(sb, p, deps);
    expect(r.code).toBe(2);
    expect(r.err).toContain("older than 24 hours");
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("refuses to approve a tampered plan", async () => {
    const { sb, deps, p } = await planned();
    tamperFile(p.file, /"size": \d+/, '"size": 2');
    const r = await cliApprove(sb, p, deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("digest mismatch");
    expect(approvalFiles(sb)).toEqual([]);
  });

  it("an approval expires: apply after the window fails", async () => {
    const { sb, app, clock, deps, p } = await planned();
    await cliApprove(sb, p, deps, ["--minutes", "5"]);
    clock.t += 6 * 60_000;
    const a = await cli(sb, ["apply", p.id, ...baseArgs(sb)], deps);
    expect(a.code).toBe(1);
    expect(a.err).toContain("expired");
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });
});

describe("cli: apply", () => {
  it("without approval exits 1, points to 'disk-janitor approve' and moves nothing", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const p = await cliPlan(sb);
    const before = treeHash(app);
    const r = await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("disk-janitor approve " + p.id);
    expect(r.err).toContain("no human approval exists");
    expect(treeHash(app)).toBe(before);
    expect(auditEvents(sb)).toContain("apply-refused");
  });

  it("with approval exits 0, prints the undo hint and moves into quarantine", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    const r = await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`applied ${p.id}: 1 directories moved to quarantine`);
    expect(r.out).toContain(`undo with:  disk-janitor restore ${p.id}`);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    expect(existsSync(join(app, "package.json"))).toBe(true);
    expect(readdirSync(join(sb.state, "quarantine", p.id, "items"))).toEqual(["0001"]);
  });

  it("an approval is single use: a second apply fails", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    expect((await cli(sb, ["apply", p.id, ...baseArgs(sb)])).code).toBe(0);
    const again = await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    expect(again.code).toBe(1);
  });

  it("a different --root than the plan's gives a config mismatch (exit 1)", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const other = join(sb.base, "other");
    mkdirSync(other);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    const r = await cli(sb, ["apply", p.id, "--root", other, "--home", sb.home, "--state-dir", sb.state, "--min-size", "1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("differs from the one the plan was made with");
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("a different --stale-days than the plan's gives a config mismatch", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    const r = await cli(sb, ["apply", p.id, ...baseArgs(sb), "--stale-days", "45"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("configuration differs");
  });

  it("aborts with a validation error if the tree changed after planning", async () => {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    writeText(join(app, "node_modules", "dep", "new.js"), "x\n");
    const r = await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing was changed");
    expect(existsSync(join(app, "node_modules", "dep", "new.js"))).toBe(true);
  });

  it("refuses a plan older than 24 hours", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const { clock, deps } = clockDeps();
    const p = await cliPlan(sb, deps);
    await cliApprove(sb, p, deps);
    clock.t += 25 * 3_600_000;
    const r = await cli(sb, ["apply", p.id, ...baseArgs(sb)], deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("older than 24 hours");
  });
});

describe("cli: restore", () => {
  async function applied() {
    const sb = makeSandbox();
    const app = oneProject(sb);
    const before = treeHash(app);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    return { sb, app, before, p };
  }

  it("restores by plan id with identical content", async () => {
    const { sb, app, before, p } = await applied();
    const r = await cli(sb, ["restore", p.id, "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`restored ${join(app, "node_modules")}`);
    expect(treeHash(app)).toBe(before);
  });

  it("restores by exact original path", async () => {
    const { sb, app, before } = await applied();
    const r = await cli(sb, ["restore", join(app, "node_modules"), "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(treeHash(app)).toBe(before);
  });

  it("--dry-run reports what would be restored and moves nothing", async () => {
    const { sb, app, p } = await applied();
    const r = await cli(sb, ["restore", p.id, "--dry-run", "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would restore ${join(app, "node_modules")}`);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
  });

  it("refuses to overwrite something that exists at the original path (exit 1)", async () => {
    const { sb, app, p } = await applied();
    writeText(join(app, "node_modules", "squatter.txt"), "mine\n");
    const r = await cli(sb, ["restore", p.id, "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED");
    expect(r.out).toContain("refusing to overwrite");
    expect(readFileSync(join(app, "node_modules", "squatter.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(sb.state, "quarantine", p.id, "items", "0001"))).toBe(true);
    const dry = await cli(sb, ["restore", p.id, "--dry-run", "--state-dir", sb.state]);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("cannot restore");
  });

  it("an unknown selector exits 1 with 'nothing to restore'", async () => {
    const { sb } = await applied();
    const r = await cli(sb, ["restore", "/no/such/path", "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing to restore");
  });

  it("restoring twice: the second run has nothing left to restore", async () => {
    const { sb, p } = await applied();
    expect((await cli(sb, ["restore", p.id, "--state-dir", sb.state])).code).toBe(0);
    const again = await cli(sb, ["restore", p.id, "--state-dir", sb.state]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("nothing to restore");
  });
});

describe("cli: purge", () => {
  async function twoGenerations() {
    const sb = makeSandbox();
    const { clock, deps } = clockDeps();
    const t0 = clock.t;
    const old = oneProject(sb, "old");
    const p1 = await cliPlan(sb, deps);
    await cliApprove(sb, p1, deps);
    expect((await cli(sb, ["apply", p1.id, ...baseArgs(sb)], deps)).code).toBe(0);
    clock.t = t0 + 5 * DAY;
    const young = oneProject(sb, "young");
    const p2 = await cliPlan(sb, deps);
    await cliApprove(sb, p2, deps);
    expect((await cli(sb, ["apply", p2.id, ...baseArgs(sb)], deps)).code).toBe(0);
    clock.t = t0 + 8 * DAY;
    return { sb, clock, deps, old, young, p1, p2 };
  }

  it("nothing is old enough right after apply", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const { deps } = clockDeps();
    const p = await cliPlan(sb, deps);
    await cliApprove(sb, p, deps);
    await cli(sb, ["apply", p.id, ...baseArgs(sb)], deps);
    const r = await cli(sb, ["purge", "--dry-run", "--state-dir", sb.state], deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to purge");
  });

  it("--dry-run lists eligible items without a TTY and deletes nothing", async () => {
    const { sb, deps, old, p1 } = await twoGenerations();
    const r = await cli(sb, ["purge", "--dry-run", "--state-dir", sb.state], deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would permanently delete 1 quarantined item(s)");
    expect(r.out).toContain(join(old, "node_modules"));
    expect(r.out).toContain(p1.id);
    expect(r.out).toContain("dry run: nothing deleted");
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
  });

  it("a real purge refuses without a TTY", async () => {
    const { sb, deps, p1 } = await twoGenerations();
    const r = await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: false, answers: ["x"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("non-interactive");
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
  });

  it("a real purge refuses when an agent marker is set", async () => {
    const { sb, deps, p1 } = await twoGenerations();
    const r = await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: true, env: { DISK_JANITOR_AGENT: "1" }, answers: ["x"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("DISK_JANITOR_AGENT");
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
  });

  it("a real purge while another operation holds the state lock exits 1 and deletes nothing", async () => {
    const { sb, deps, clock, p1 } = await twoGenerations();
    const state = await stateOf(sb);
    const { items } = await purgeCandidates(state, 7 * DAY, clock.t);
    const held = await acquireLock(state.lockPath);
    try {
      const r = await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: true, answers: [purgeSetDigest(items).slice(0, 8)] });
      expect(r.code).toBe(1);
      expect(r.err).toContain("another disk-janitor operation holds the lock");
    } finally {
      await held.release();
    }
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
    expect(auditEvents(sb)).not.toContain("purge-begin");
  });

  it("restore while another operation holds the state lock exits 1 and restores nothing; a dry run still works", async () => {
    const { sb, deps, p1 } = await twoGenerations();
    const state = await stateOf(sb);
    const held = await acquireLock(state.lockPath);
    try {
      const r = await cli(sb, ["restore", p1.id, "--state-dir", sb.state], deps, {});
      expect(r.code).toBe(1);
      expect(r.err).toContain("another disk-janitor operation holds the lock");
      const dry = await cli(sb, ["restore", p1.id, "--dry-run", "--state-dir", sb.state], deps, {});
      expect(dry.code).toBe(0);
    } finally {
      await held.release();
    }
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
    expect(auditEvents(sb)).not.toContain("restore-begin");
  });

  it("a wrong confirmation cancels and every item is still there", async () => {
    const { sb, deps, p1, p2 } = await twoGenerations();
    const r = await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: true, answers: ["12345678"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("purge cancelled");
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(true);
    expect(existsSync(join(sb.state, "quarantine", p2.id, "items", "0001"))).toBe(true);
    expect(auditEvents(sb)).not.toContain("purge-done");
  });

  it("the right confirmation deletes only items older than --ttl-days", async () => {
    const { sb, deps, clock, p1, p2 } = await twoGenerations();
    const state = await stateOf(sb);
    const { items } = await purgeCandidates(state, 7 * DAY, clock.t);
    expect(items.map((i) => i.planId)).toEqual([p1.id]);
    const expected = purgeSetDigest(items).slice(0, 8);
    const r = await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: true, answers: [expected] });
    expect(r.code).toBe(0);
    expect(r.io.asked[0]).not.toContain(expected);
    expect(r.io.asked[0]).toContain("purge --dry-run");
    expect(r.out).toContain("purged 1 item(s)");
    expect(existsSync(join(sb.state, "quarantine", p1.id, "items", "0001"))).toBe(false);
    expect(existsSync(join(sb.state, "quarantine", p2.id, "items", "0001"))).toBe(true);
    const after = await purgeCandidates(state, 7 * DAY, clock.t);
    expect(after.items).toEqual([]);
  });

  it("--ttl-days 3 selects both generations and the combined digest purges both", async () => {
    const { sb, deps, clock, p1, p2 } = await twoGenerations();
    const state = await stateOf(sb);
    const { items } = await purgeCandidates(state, 3 * DAY, clock.t);
    expect(items.map((i) => i.planId).sort()).toEqual([p1.id, p2.id].sort());
    const r = await cli(sb, ["purge", "--ttl-days", "3", "--state-dir", sb.state], deps, { tty: true, answers: [purgeSetDigest(items).slice(0, 8)] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("purged 2 item(s)");
    expect(existsSync(join(sb.state, "quarantine", p2.id, "items", "0001"))).toBe(false);
  });

  it("purged items can no longer be restored", async () => {
    const { sb, deps, clock, old, p1 } = await twoGenerations();
    const state = await stateOf(sb);
    const { items } = await purgeCandidates(state, 7 * DAY, clock.t);
    await cli(sb, ["purge", "--state-dir", sb.state], deps, { tty: true, answers: [purgeSetDigest(items).slice(0, 8)] });
    const r = await cli(sb, ["restore", p1.id, "--state-dir", sb.state], deps);
    expect(r.code).toBe(1);
    expect(existsSync(join(old, "node_modules"))).toBe(false);
  });

  it("--ttl-days with a non-integer is a usage error", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["purge", "--ttl-days", "soon", "--state-dir", sb.state]);
    expect(r.code).toBe(2);
  });
});

describe("cli: status, audit, doctor", () => {
  it("status on an empty state dir says quarantine is empty and the chain is OK", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["status", "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("quarantine: empty");
    expect(r.out).toContain("audit log: chain OK, 0 entries");
  });

  it("status shows quarantine and audit after an apply", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    const r = await cli(sb, ["status", "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`quarantine ${p.id}: 1 quarantined`);
    expect(r.out).toContain("chain OK");
    expect(r.out).toContain("plans: 1");
  });

  it("status --json parses and carries counts and audit state", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    await cli(sb, ["apply", p.id, ...baseArgs(sb)]);
    const r = await cli(sb, ["status", "--json", "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out) as {
      stateDir: string;
      plans: number;
      quarantine: Array<{ planId: string; counts: Record<string, number>; quarantinedBytes: number }>;
      audit: { ok: boolean; entries: number };
      applyLockHeld: boolean;
    };
    expect(data.stateDir).toBe(sb.state);
    expect(data.plans).toBe(1);
    expect(data.quarantine).toHaveLength(1);
    expect(data.quarantine[0]?.planId).toBe(p.id);
    expect(data.quarantine[0]?.counts).toEqual({ quarantined: 1 });
    expect(data.quarantine[0]?.quarantinedBytes).toBeGreaterThan(0);
    expect(data.audit.ok).toBe(true);
    expect(data.audit.entries).toBe(auditEvents(sb).length);
    expect(data.applyLockHeld).toBe(false);
  });

  it("status exits 1 and names the line when the audit log is tampered", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    await cliPlan(sb);
    tamperFile(join(sb.state, "audit.jsonl"), /plan-created/, "plan-forged!");
    const r = await cli(sb, ["status", "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("BROKEN at line 1");
  });

  it("audit prints one JSON object per line and reports the chain as OK", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    const r = await cli(sb, ["audit", "--state-dir", sb.state]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n").filter(Boolean);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(["plan-created", "approval-issued"]);
    expect(r.err).toContain("audit chain OK: 2 entries");
  });

  it("audit exits 1 on a tampered log", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    tamperFile(join(sb.state, "audit.jsonl"), /approval-issued/, "approval-issueX");
    const r = await cli(sb, ["audit", "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("audit chain BROKEN at line 2");
    expect(r.err).toContain("hash mismatch");
  });

  it("audit exits 1 when a line is deleted from the middle", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    const file = join(sb.state, "audit.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, lines.slice(1).join("\n") + "\n");
    const r = await cli(sb, ["audit", "--state-dir", sb.state]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("BROKEN");
  });

  it("doctor on a healthy state dir exits 0 and reports mode, key, git, lsof and docker", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["doctor", "--state-dir", sb.state, "--home", sb.home]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mode 700 (expected 700)");
    expect(r.out).toContain("approval key not created yet");
    expect(r.out).toContain("audit chain intact (0 entries)");
    expect(r.out).toContain("rename within the quarantine works");
    expect(r.out).toMatch(/git version/);
    expect(r.out).toContain("lsof not found");
    expect(r.out).toContain("docker not found");
    expect(r.out).toContain("stdin tty: false, stdout tty: false");
    expect(readdirSync(join(sb.state, "quarantine"))).toEqual([]);
  });

  it("doctor sees the approval key once a human approved something", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    const p = await cliPlan(sb);
    await cliApprove(sb, p);
    expect(statSync(join(sb.state, "key")).mode & 0o777).toBe(0o600);
    const r = await cli(sb, ["doctor", "--state-dir", sb.state, "--home", sb.home, "--root", sb.projects]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("approval key present, mode 0600");
    expect(r.out).toContain("same file system as the quarantine");
  });

  it("doctor reports lsof as available when the runner provides it", async () => {
    const sb = makeSandbox();
    const r = await cli(sb, ["doctor", "--state-dir", sb.state, "--home", sb.home], testDeps({ lsof: [], docker: () => ({ stdout: "Docker version 1.2.3\n" }) }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("lsof available");
    expect(r.out).toContain("Docker version 1.2.3");
  });

  it("doctor exits 1 when the state dir is group-writable", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.state, { mode: 0o700 });
    chmodSync(sb.state, 0o770);
    const r = await cli(sb, ["doctor", "--state-dir", sb.state, "--home", sb.home]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    expect(r.out).toContain("group- or world-writable");
  });

  it("doctor exits 1 when the audit chain is broken", async () => {
    const sb = makeSandbox();
    oneProject(sb);
    await cliPlan(sb);
    tamperFile(join(sb.state, "audit.jsonl"), /plan-created/, "plan-forged!");
    const r = await cli(sb, ["doctor", "--state-dir", sb.state, "--home", sb.home]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("audit chain broken at line 1");
  });
});

describe("cli: approve --approver dialog", () => {
  async function plannedForDialog() {
    const sb = makeSandbox();
    makeProject(join(sb.projects, "a"), { nodeModules: 5000 });
    const deps = testDeps();
    const planned = await cli(sb, ["plan", ...baseArgs(sb)], deps);
    expect(planned.code).toBe(0);
    const id = /plan-\d{8}T\d{6}Z-[0-9a-f]{8}/.exec(planned.out)?.[0] as string;
    return { sb, id };
  }

  /** deps whose runner plays the part of zenity: `answer` is its exit code. */
  function zenityDeps(answer: number) {
    const base = testDeps();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    return {
      calls,
      deps: {
        ...base,
        run: async (command: string, args: readonly string[], o?: Parameters<typeof base.run>[2]) => {
          if (command === "zenity") {
            calls.push({ command, args });
            return { code: args[0] === "--version" ? 0 : answer, stdout: "", stderr: "" };
          }
          return base.run(command, args, o);
        },
      },
    };
  }

  it("an approving dialog issues the approval without any terminal and without prompting", async () => {
    const { sb, id } = await plannedForDialog();
    const { deps, calls } = zenityDeps(0);
    const r = await cli(sb, ["approve", id, "--approver", "dialog", "--state-dir", sb.state], deps, { tty: false, env: { DISPLAY: ":0" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("approved until");
    expect(r.io.asked).toEqual([]);
    expect(readdirSync(join(sb.state, "approvals")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    const asked = calls.at(-1) as { args: readonly string[] };
    expect(asked.args[0]).toBe("--question");
    expect(JSON.stringify(readFileSync(join(sb.state, "audit.jsonl"), "utf8"))).toContain("os-dialog");
  });

  it("a cancelled dialog exits 1 and issues nothing", async () => {
    const { sb, id } = await plannedForDialog();
    const { deps } = zenityDeps(1);
    const r = await cli(sb, ["approve", id, "--approver", "dialog", "--state-dir", sb.state], deps, { env: { DISPLAY: ":0" } });
    expect(r.code).toBe(1);
    expect(readdirSync(join(sb.state, "approvals")).filter((n) => n.endsWith(".json"))).toHaveLength(0);
    expect(readFileSync(join(sb.state, "audit.jsonl"), "utf8")).toContain("approval-declined");
  });

  it("without a graphical session the dialog approver is unavailable and nothing falls back to the terminal", async () => {
    const { sb, id } = await plannedForDialog();
    const { deps } = zenityDeps(0);
    const r = await cli(sb, ["approve", id, "--approver", "dialog", "--state-dir", sb.state], deps, { tty: true, env: {}, answers: ["anything"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no OS confirmation dialog is available");
    expect(r.io.asked).toEqual([]);
  });

  it("an unknown --approver value is a usage error", async () => {
    const { sb, id } = await plannedForDialog();
    const r = await cli(sb, ["approve", id, "--approver", "telepathy", "--state-dir", sb.state], testDeps(), { tty: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--approver must be");
  });

  it("the dialog approver does not bypass the age rule for old plans", async () => {
    const { sb, id } = await plannedForDialog();
    const { deps } = zenityDeps(0);
    const old = { ...deps, now: () => Date.now() + 25 * 3_600_000 };
    const r = await cli(sb, ["approve", id, "--approver", "dialog", "--state-dir", sb.state], old, { env: { DISPLAY: ":0" } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("older than 24 hours");
  });
});
