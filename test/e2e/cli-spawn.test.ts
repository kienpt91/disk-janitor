import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { parsePlan } from "../../src/domain/plan/plan.js";
import { openState } from "../../src/infrastructure/state/state-dir.js";
import { approveAsHuman, makeProject, makeSandbox, testDeps, treeHash, type Sandbox } from "../support/helpers.js";

const DIST = process.env["DJ_TEST_DIST"] as string; // set by global setup; asserted below
const BIN = join(DIST, "infrastructure", "cli", "bin.js");
const MCP_BIN = join(DIST, "infrastructure", "mcp", "bin.js");

interface Spawned {
  code: number | null;
  out: string;
  err: string;
}

/** Child environment: HOME is the sandbox home, XDG_STATE_HOME and agent markers are absent. */
function childEnv(sb: Sandbox): Record<string, string> {
  return { HOME: sb.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
}

function run(script: string, args: string[], sb: Sandbox): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv(sb), cwd: sb.base, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => void (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => void (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function flags(sb: Sandbox): string[] {
  return ["--root", sb.projects, "--home", sb.home, "--state-dir", sb.state, "--min-size", "1"];
}

describe("spawned bin.js", () => {
  it("the compiled binaries exist", () => {
    expect(DIST).toBeTruthy();
    expect(existsSync(BIN)).toBe(true);
    expect(existsSync(MCP_BIN)).toBe(true);
  });

  it("--help prints usage and exits 0", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["--help"], sb);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: disk-janitor <command>");
    expect(r.out).toContain("approve <plan>        HUMAN ONLY");
  });

  it("no command exits 2", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, [], sb);
    expect(r.code).toBe(2);
  });

  it("an unknown flag exits 2 with the message on stderr", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["scan", "--bogus"], sb);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--bogus");
  });

  it("approve exits 1 with the non-interactive message when stdin is not a terminal", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["approve", "plan-20260101T000000Z-00000000", "--state-dir", sb.state], sb);
    expect(r.code).toBe(1);
    expect(r.err).toContain("approve needs an interactive terminal");
    expect(r.err).toContain("non-interactive session");
    expect(existsSync(join(sb.state, "approvals"))).toBe(false);
  });

  it("purge with nothing quarantined is a no-op even without a terminal", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["purge", "--ttl-days", "0", "--state-dir", sb.state], sb);
    // nothing is quarantined, so there is nothing to confirm; it must not delete or prompt
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to purge");
  });

  it("scan exits 0 and lists the fixture node_modules", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 4096 });
    const before = treeHash(sb.projects);
    const r = await run(BIN, ["scan", ...flags(sb)], sb);
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(app, "node_modules"));
    expect(r.out).toContain("nothing was changed");
    expect(treeHash(sb.projects)).toBe(before);
    expect(existsSync(sb.state)).toBe(false);
  });

  it("scan without a root fails with a message and exits 1", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["scan", "--home", sb.home, "--state-dir", sb.state], sb);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no roots configured");
  });

  it("scan --root <home> is refused", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["scan", "--root", sb.home, "--home", sb.home], sb);
    expect(r.code).toBe(1);
    expect(r.err).toContain("home directory");
  });

  it("the default state directory comes from HOME when XDG_STATE_HOME is unset", async () => {
    const sb = makeSandbox();
    const r = await run(BIN, ["doctor"], sb);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.home, ".local", "state", "disk-janitor", "plans"))).toBe(true);
    expect(r.out).toContain(join(sb.home, ".local", "state", "disk-janitor"));
  });

  it("plan -> human approval -> apply -> restore round-trips with identical content", async () => {
    const sb = makeSandbox();
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 4096 });
    const other = makeProject(join(sb.projects, "other"), { nodeModules: 3000, lockfile: "yarn.lock" });
    const hashApp = treeHash(app);
    const hashOther = treeHash(other);

    const planned = await run(BIN, ["plan", ...flags(sb)], sb);
    expect(planned.code).toBe(0);
    const id = /plan:\s+(plan-\S+)/.exec(planned.out)?.[1] ?? "";
    expect(id).toMatch(/^plan-/);
    expect(treeHash(app)).toBe(hashApp);

    const denied = await run(BIN, ["apply", id, ...flags(sb)], sb);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("disk-janitor approve " + id);
    expect(existsSync(join(app, "node_modules"))).toBe(true);

    const plan = parsePlan(readFileSync(join(sb.state, "plans", `${id}.json`), "utf8"));
    const state = await openState(sb.state, [sb.projects]);
    await approveAsHuman(state, plan, testDeps());

    const applied = await run(BIN, ["apply", id, ...flags(sb)], sb);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(`undo with:  disk-janitor restore ${id}`);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    expect(existsSync(join(other, "node_modules"))).toBe(false);

    const status = await run(BIN, ["status", "--state-dir", sb.state], sb);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`quarantine ${id}: 2 quarantined`);

    const restored = await run(BIN, ["restore", id, "--state-dir", sb.state], sb);
    expect(restored.code).toBe(0);
    expect(treeHash(app)).toBe(hashApp);
    expect(treeHash(other)).toBe(hashOther);

    const audit = await run(BIN, ["audit", "--state-dir", sb.state], sb);
    expect(audit.code).toBe(0);
    expect(audit.err).toContain("audit chain OK");
    const events = audit.out.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("apply-complete");
    expect(events).toContain("restore-done");
  });
});

describe("spawned mcp-bin.js over stdio", () => {
  const open: Client[] = [];

  afterEach(async () => {
    while (open.length > 0) await (open.pop() as Client).close();
  });

  async function connectStdio(sb: Sandbox): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BIN, "--root", sb.projects, "--home", sb.home, "--state-dir", sb.state, "--stale-days", "30"],
      env: childEnv(sb),
      cwd: sb.base,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    open.push(client);
    return client;
  }

  it("lists seven tools and none that approves or purges", async () => {
    const sb = makeSandbox();
    const client = await connectStdio(sb);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["apply_plan", "explain_plan", "list_quarantine", "plan", "restore_preview", "scan", "status"]);
    expect(names.some((n) => /approve|purge/.test(n))).toBe(false);
    expect(client.getInstructions()).toContain("HUMAN approves");
  });

  it("scan works and reports the fixture; apply_plan without approval is an error", async () => {
    const sb = makeSandbox();
    // mcp-bin has no size flag: the default minimum is 1 MiB, so the fixture must exceed it
    const app = makeProject(join(sb.projects, "app"), { nodeModules: 1_200_000 });
    const client = await connectStdio(sb);
    const scanned = await client.callTool({ name: "scan", arguments: {} });
    const text = (scanned.content as Array<{ text: string }>).map((c) => c.text).join("\n");
    expect(scanned.isError).toBeFalsy();
    expect(text).toContain(`<untrusted-data>${join(app, "node_modules")}</untrusted-data>`);

    const planned = await client.callTool({ name: "plan", arguments: {} });
    const body = (planned.content as Array<{ text: string }>)[0]?.text ?? "";
    const id = /plan-\d{8}T\d{6}Z-[0-9a-f]{8}/.exec(body)?.[0] ?? "";
    expect(id).not.toBe("");
    const applied = await client.callTool({ name: "apply_plan", arguments: { plan_id: id } });
    expect(applied.isError).toBe(true);
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("a bad root (the home directory) makes the process exit non-zero with a message", async () => {
    const sb = makeSandbox();
    const r = await run(MCP_BIN, ["--root", sb.home, "--home", sb.home, "--state-dir", sb.state], sb);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("disk-janitor-mcp:");
    expect(r.err).toContain("home directory");
  });

  it("no root at all makes the process exit non-zero", async () => {
    const sb = makeSandbox();
    const r = await run(MCP_BIN, ["--home", sb.home, "--state-dir", sb.state], sb);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no roots configured");
  });

  it("--help prints usage and exits 0", async () => {
    const sb = makeSandbox();
    const r = await run(MCP_BIN, ["--help"], sb);
    expect(r.code).toBe(0);
    expect(r.out).toContain("disk-janitor-mcp");
  });
});
