import { describe, expect, it } from "vitest";
import { approvePlan, consumeApproval, issueApproval, verifyApproval, type ApprovePlanPorts, type IssueApprovalPorts } from "../../src/application/approvals.js";
import { APPROVAL_PAGE_SIZE, terminalApprover, type Approver, type ApprovalView } from "../../src/application/approvers.js";
import { createPlan } from "../../src/application/plans.js";
import type { KeyStore } from "../../src/application/ports/planning.js";
import { DEFAULT_VALIDITY_MS, MAX_VALIDITY_MS } from "../../src/domain/approval/approval.js";
import type { Plan } from "../../src/domain/model/types.js";
import { AGENT_ENV_MARKERS, digestPrefix, HumanRequiredError } from "../../src/domain/policy/human.js";
import { MAX_PLAN_AGE_MS, PlanTooOldError } from "../../src/domain/plan/plan.js";
import { fsInput, makeConfig, ROOT } from "../support/builders.js";
import { FakeClock, FakeIds } from "../support/fakes/clock.js";
import { MemoryApprovalStore, MemoryAuditTrail, MemoryKeyStore, MemoryPlanStore, ScriptedTerminal, type KeyVault, type TerminalOptions } from "../support/fakes/memory-stores.js";

const MIN = 60_000;

interface World {
  clock: FakeClock;
  ids: FakeIds;
  plans: MemoryPlanStore;
  approvals: MemoryApprovalStore;
  vault: KeyVault;
  keys: MemoryKeyStore;
  audit: MemoryAuditTrail;
  issuePorts: IssueApprovalPorts;
  approvePorts: ApprovePlanPorts;
  verifyPorts: { clock: FakeClock; keys: MemoryKeyStore; approvals: MemoryApprovalStore; audit: MemoryAuditTrail };
}

function setup(): World {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const plans = new MemoryPlanStore();
  const approvals = new MemoryApprovalStore();
  const vault: KeyVault = { key: null };
  const keys = new MemoryKeyStore(vault);
  const audit = new MemoryAuditTrail(() => clock.now());
  return {
    clock,
    ids,
    plans,
    approvals,
    vault,
    keys,
    audit,
    issuePorts: { clock, ids, keys, approvals },
    approvePorts: { clock, ids, keys, approvals, events: audit },
    verifyPorts: { clock, keys, approvals, audit },
  };
}

async function newPlan(w: World, path = `${ROOT}/alpha/node_modules`): Promise<Plan> {
  return (await createPlan({ clock: w.clock, ids: w.ids, plans: w.plans, events: w.audit }, makeConfig(), { fs: [fsInput(path)], docker: [], reports: [] })).plan;
}

const view: ApprovalView = {
  header: (plan, validityMs) => [`Plan ${plan.id}`, `valid for ${validityMs / MIN} minutes`],
  candidates: (plan) => plan.candidates.map((c) => `candidate ${c.id}`),
};
const typing = (plan: Plan, extra: TerminalOptions = {}) => new ScriptedTerminal([plan.digest], extra);
const via = (term: ScriptedTerminal, pageSize?: number): Approver => terminalApprover(term, view, pageSize);

/** A plan with `n` file-system candidates (distinct projects under the root). */
async function bigPlan(w: World, n: number): Promise<Plan> {
  const fs = Array.from({ length: n }, (_, i) => fsInput(`${ROOT}/p${String(i).padStart(4, "0")}/node_modules`));
  return (await createPlan({ clock: w.clock, ids: w.ids, plans: w.plans, events: w.audit }, makeConfig(), { fs, docker: [], reports: [] })).plan;
}

describe("issueApproval", () => {
  it("stores a record under the plan digest and returns it", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    expect(w.approvals.names()).toEqual([`${plan.digest}.json`]);
    expect(JSON.parse((await w.approvals.read(plan.digest)) as string)).toEqual(record);
    expect(record).toMatchObject({ version: 1, purpose: "apply", planId: plan.id, planDigest: plan.digest, issuedAt: w.clock.now() });
  });

  it("uses a 15 minute validity by default and the nonce from the id source", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    expect(record.expiresAt - record.issuedAt).toBe(15 * MIN);
    expect(record.nonce).toBe("00000000000000000000000000000002");
  });

  it("honours a custom validity up to the maximum", async () => {
    const w = setup();
    const plan = await newPlan(w);
    expect((await issueApproval(w.issuePorts, plan, MAX_VALIDITY_MS)).expiresAt).toBe(w.clock.now() + MAX_VALIDITY_MS);
  });

  it("creates the key on first use", async () => {
    const w = setup();
    const plan = await newPlan(w);
    expect(w.vault.key).toBeNull();
    await issueApproval(w.issuePorts, plan);
    expect(w.vault.key).not.toBeNull();
  });

  it("fails when the key cannot be loaded and stores nothing", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const noKeys: KeyStore = { signer: async () => null };
    await expect(issueApproval({ ...w.issuePorts, keys: noKeys }, plan)).rejects.toThrow("could not load the approval key");
    expect(w.approvals.size).toBe(0);
  });

  it.each([0, -1, MAX_VALIDITY_MS + 1])("rejects a validity of %i and stores nothing", async (v) => {
    const w = setup();
    const plan = await newPlan(w);
    await expect(issueApproval(w.issuePorts, plan, v)).rejects.toThrow("approval validity must be between 1 ms and 60 minutes");
    expect(w.approvals.size).toBe(0);
  });

  it("publishes no events by itself", async () => {
    const w = setup();
    const plan = await newPlan(w);
    await issueApproval(w.issuePorts, plan);
    expect((await w.audit.logged()).map((e) => e.name)).toEqual(["plan-created"]);
  });

  it("a second approval for the same plan replaces the first", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const first = await issueApproval(w.issuePorts, plan);
    w.clock.advance(1000);
    const second = await issueApproval(w.issuePorts, plan);
    expect(second.nonce).not.toBe(first.nonce);
    expect(w.approvals.size).toBe(1);
    expect(JSON.parse((await w.approvals.read(plan.digest)) as string)).toEqual(second);
  });
});

describe("verifyApproval", () => {
  it("accepts the record that was just issued", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: true, record });
  });

  it("refuses when no approval exists", async () => {
    const w = setup();
    const plan = await newPlan(w);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "no human approval exists for this plan digest" });
  });

  it("reports an unreadable record without throwing", async () => {
    const w = setup();
    const plan = await newPlan(w);
    w.approvals.read = async () => {
      throw new Error("EIO");
    };
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval record unreadable" });
  });

  it("expires with the clock: valid one millisecond before, refused exactly at expiry", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan, 10 * MIN);
    w.clock.advance(10 * MIN - 1);
    expect((await verifyApproval(w.verifyPorts, plan)).ok).toBe(true);
    w.clock.advance(1);
    expect(w.clock.now()).toBe(record.expiresAt);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval has expired" });
    w.clock.advance(MAX_PLAN_AGE_MS);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval has expired" });
  });

  it("cannot be used for another plan", async () => {
    const w = setup();
    const planA = await newPlan(w, `${ROOT}/alpha/node_modules`);
    const planB = await newPlan(w, `${ROOT}/beta/node_modules`);
    expect(planA.digest).not.toBe(planB.digest);
    await issueApproval(w.issuePorts, planA);
    expect(await verifyApproval(w.verifyPorts, planB)).toEqual({ ok: false, reason: "no human approval exists for this plan digest" });
  });

  it("refuses a record copied into another plan's slot", async () => {
    const w = setup();
    const planA = await newPlan(w, `${ROOT}/alpha/node_modules`);
    const planB = await newPlan(w, `${ROOT}/beta/node_modules`);
    await issueApproval(w.issuePorts, planA);
    await w.approvals.write(planB.digest, (await w.approvals.read(planA.digest)) as string);
    expect(await verifyApproval(w.verifyPorts, planB)).toEqual({ ok: false, reason: "approval was issued for a different plan" });
  });

  it("is refused when the key is missing", async () => {
    const w = setup();
    const plan = await newPlan(w);
    await issueApproval(w.issuePorts, plan);
    w.vault.key = null;
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "no approval key exists" });
    expect(w.vault.key).toBeNull();
  });

  it("is refused when the key was replaced", async () => {
    const w = setup();
    const plan = await newPlan(w);
    await issueApproval(w.issuePorts, plan);
    w.vault.key = "another-key";
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval signature is invalid" });
  });

  it("is refused when the stored record was edited to extend its life", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    await w.approvals.write(plan.digest, JSON.stringify({ ...record, expiresAt: record.expiresAt + 1000 }));
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval signature is invalid" });
  });

  it("is refused when the stored text is garbage", async () => {
    const w = setup();
    const plan = await newPlan(w);
    await w.approvals.write(plan.digest, "not json");
    const result = await verifyApproval(w.verifyPorts, plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^approval record invalid: /);
  });

  it("a consumed approval cannot be replayed, even from a copy of the file", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    const copy = (await w.approvals.read(plan.digest)) as string;
    await consumeApproval({ approvals: w.approvals, events: w.audit }, record);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "no human approval exists for this plan digest" });
    await w.approvals.write(plan.digest, copy);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval was already used" });
  });

  it("consuming one approval does not spend a later one for the same plan", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const first = await issueApproval(w.issuePorts, plan);
    await consumeApproval({ approvals: w.approvals, events: w.audit }, first);
    const second = await issueApproval(w.issuePorts, plan);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: true, record: second });
  });
});

describe("consumeApproval", () => {
  it("publishes approval-consumed with the nonce and removes the record", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    await consumeApproval({ approvals: w.approvals, events: w.audit }, record);
    expect((await w.audit.logged()).at(-1)).toEqual({ name: "approval-consumed", data: { planId: plan.id, planDigest: plan.digest, nonce: record.nonce } });
    expect(await w.approvals.read(plan.digest)).toBeNull();
  });

  it("does not fail when the record is already gone", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    await w.approvals.remove(plan.digest);
    await expect(consumeApproval({ approvals: w.approvals, events: w.audit }, record)).resolves.toBeUndefined();
    expect((await w.audit.logged()).at(-1)?.name).toBe("approval-consumed");
  });

  it("records the use in the audit trail before removing the file", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const record = await issueApproval(w.issuePorts, plan);
    const failing = {
      publish: async () => {
        throw new Error("audit unavailable");
      },
    };
    await expect(consumeApproval({ approvals: w.approvals, events: failing }, record)).rejects.toThrow("audit unavailable");
    expect(await w.approvals.read(plan.digest)).not.toBeNull();
    expect((await verifyApproval(w.verifyPorts, plan)).ok).toBe(true);
  });
});

describe("approvePlan", () => {
  it("issues an approval when the human types the full digest, and logs it in order", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const result = await approvePlan(w.approvePorts, via(typing(plan)), plan, DEFAULT_VALIDITY_MS);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.record.planDigest).toBe(plan.digest);
    expect(result.record.expiresAt).toBe(w.clock.now() + DEFAULT_VALIDITY_MS);
    expect(await w.audit.logged()).toEqual([
      { name: "plan-created", data: expect.objectContaining({ planId: plan.id, candidates: 1 }) },
      {
        name: "approval-issued",
        data: { planId: plan.id, planDigest: plan.digest, expiresAt: result.record.expiresAt, nonce: result.record.nonce, approver: "terminal" },
      },
    ]);
    expect((await w.audit.verify()).ok).toBe(true);
  });

  it("the stored approval verifies and then expires with the clock", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const result = await approvePlan(w.approvePorts, via(typing(plan)), plan, 2 * MIN);
    if (!result.approved) throw new Error("expected approval");
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: true, record: result.record });
    w.clock.advance(2 * MIN);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval has expired" });
  });

  it("prints the header and every candidate through the terminal before prompting", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const term = typing(plan);
    await approvePlan(w.approvePorts, via(term), plan, 5 * MIN);
    expect(term.written).toEqual([`Plan ${plan.id}`, "valid for 5 minutes", "candidate c0001", ""]);
    expect(term.prompts).toHaveLength(1);
  });

  it("the prompt does not contain the digest or any prefix of it (it must be read elsewhere)", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const term = typing(plan);
    await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS);
    const everything = [...term.written, ...term.prompts].join("\n");
    expect(everything).not.toContain(plan.digest);
    expect(everything).not.toContain(digestPrefix(plan.digest));
    expect(everything).not.toContain(plan.digest.slice(0, 4));
    expect(term.prompts[0]).toContain("full plan digest");
    expect(term.prompts[0]).toContain("disk-janitor explain");
  });

  it("the old 8-character prefix is no longer enough", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const term = new ScriptedTerminal([digestPrefix(plan.digest)]);
    expect(await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).toEqual({ approved: false });
    expect(w.approvals.size).toBe(0);
  });

  it("accepts the full digest with surrounding whitespace", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const term = new ScriptedTerminal([`  ${plan.digest}\n`]);
    expect((await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).approved).toBe(true);
  });

  it("the approval is bound to this plan only", async () => {
    const w = setup();
    const planA = await newPlan(w, `${ROOT}/alpha/node_modules`);
    const planB = await newPlan(w, `${ROOT}/beta/node_modules`);
    await approvePlan(w.approvePorts, via(typing(planA)), planA, DEFAULT_VALIDITY_MS);
    expect((await verifyApproval(w.verifyPorts, planA)).ok).toBe(true);
    expect((await verifyApproval(w.verifyPorts, planB)).ok).toBe(false);
  });

  it("the digest of another plan does not approve this one", async () => {
    const w = setup();
    const planA = await newPlan(w, `${ROOT}/alpha/node_modules`);
    const planB = await newPlan(w, `${ROOT}/beta/node_modules`);
    expect(await approvePlan(w.approvePorts, via(new ScriptedTerminal([planB.digest])), planA, DEFAULT_VALIDITY_MS)).toEqual({ approved: false });
  });

  it("an approval cannot be replayed after it is consumed", async () => {
    const w = setup();
    const plan = await newPlan(w);
    const result = await approvePlan(w.approvePorts, via(typing(plan)), plan, DEFAULT_VALIDITY_MS);
    if (!result.approved) throw new Error("expected approval");
    const copy = (await w.approvals.read(plan.digest)) as string;
    await consumeApproval({ approvals: w.approvals, events: w.audit }, result.record);
    await w.approvals.write(plan.digest, copy);
    expect(await verifyApproval(w.verifyPorts, plan)).toEqual({ ok: false, reason: "approval was already used" });
    expect((await w.audit.logged()).map((e) => e.name)).toEqual(["plan-created", "approval-issued", "approval-consumed"]);
  });

  describe("every candidate is shown, in pages", () => {
    it("lists all 45 candidates in pages of 20 and asks between pages", async () => {
      const w = setup();
      const plan = await bigPlan(w, 45);
      const term = new ScriptedTerminal(["", "", plan.digest]);
      const result = await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS);
      expect(result.approved).toBe(true);
      const shown = term.written.filter((l) => l.startsWith("candidate "));
      expect(shown).toHaveLength(45);
      expect(shown[0]).toBe("candidate c0001");
      expect(shown.at(-1)).toBe("candidate c0045");
      expect(term.prompts[0]).toContain("20 of 45 candidates shown");
      expect(term.prompts[1]).toContain("40 of 45 candidates shown");
      expect(term.prompts).toHaveLength(3);
    });

    it("does not truncate large plans: 300 candidates are all displayed", async () => {
      const w = setup();
      const plan = await bigPlan(w, 300);
      const pages = Math.ceil(300 / APPROVAL_PAGE_SIZE) - 1;
      const term = new ScriptedTerminal([...Array<string>(pages).fill(""), plan.digest]);
      await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS);
      expect(term.written.filter((l) => l.startsWith("candidate "))).toHaveLength(300);
    });

    it("q at a page break cancels: later candidates are not shown, the digest is never asked, nothing is issued", async () => {
      const w = setup();
      const plan = await bigPlan(w, 45);
      const term = new ScriptedTerminal(["q"]);
      expect(await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).toEqual({ approved: false });
      expect(term.written.filter((l) => l.startsWith("candidate "))).toHaveLength(20);
      expect(term.prompts).toHaveLength(1);
      expect(w.approvals.size).toBe(0);
      expect((await w.audit.logged()).at(-1)).toEqual({ name: "approval-declined", data: { planId: plan.id, planDigest: plan.digest, approver: "terminal" } });
    });

    it("a plan that fits on one page asks only for the digest", async () => {
      const w = setup();
      const plan = await bigPlan(w, APPROVAL_PAGE_SIZE);
      const term = typing(plan);
      await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS);
      expect(term.prompts).toHaveLength(1);
    });
  });

  describe("declined", () => {
    it.each(["", "no", "y", "yes", "0123abcd", "UPPER", "x".repeat(100)])("answer %j publishes approval-declined and issues nothing", async (answer) => {
      const w = setup();
      const plan = await newPlan(w);
      const term = new ScriptedTerminal([answer]);
      expect(await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).toEqual({ approved: false });
      expect(await w.audit.logged()).toEqual([
        { name: "plan-created", data: expect.anything() },
        { name: "approval-declined", data: { planId: plan.id, planDigest: plan.digest, approver: "terminal" } },
      ]);
      expect(w.approvals.size).toBe(0);
      expect(w.vault.key).toBeNull();
    });

    it("an uppercase copy of the digest is wrong", async () => {
      const w = setup();
      const plan = await newPlan(w);
      const term = new ScriptedTerminal([plan.digest.toUpperCase()]);
      expect((await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).approved).toBe(false);
    });

    it("still shows the plan before the human declines", async () => {
      const w = setup();
      const plan = await newPlan(w);
      const term = new ScriptedTerminal(["no"]);
      await approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS);
      expect(term.written).toEqual([`Plan ${plan.id}`, "valid for 15 minutes", "candidate c0001", ""]);
    });
  });

  describe("another approver (an OS dialog) goes through the same use case", () => {
    const dialog = (decision: "approved" | "declined", seen: string[] = []): Approver => ({
      kind: "os-dialog",
      decide: async (plan) => {
        seen.push(plan.id);
        return decision;
      },
    });

    it("an approving dialog issues the approval and records the approver kind", async () => {
      const w = setup();
      const plan = await newPlan(w);
      const seen: string[] = [];
      const result = await approvePlan(w.approvePorts, dialog("approved", seen), plan, DEFAULT_VALIDITY_MS);
      expect(result.approved).toBe(true);
      expect(seen).toEqual([plan.id]);
      const last = (await w.audit.logged()).at(-1);
      expect(last).toEqual({ name: "approval-issued", data: expect.objectContaining({ planId: plan.id, approver: "os-dialog" }) });
    });

    it("a declining dialog issues nothing and records the decline with the approver kind", async () => {
      const w = setup();
      const plan = await newPlan(w);
      expect(await approvePlan(w.approvePorts, dialog("declined"), plan, DEFAULT_VALIDITY_MS)).toEqual({ approved: false });
      expect((await w.audit.logged()).at(-1)).toEqual({ name: "approval-declined", data: { planId: plan.id, planDigest: plan.digest, approver: "os-dialog" } });
      expect(w.approvals.size).toBe(0);
    });

    it("a dialog approver is not subject to the terminal session checks", async () => {
      const w = setup();
      const plan = await newPlan(w);
      // no terminal exists at all; only the plan age rule still applies
      expect((await approvePlan(w.approvePorts, dialog("approved"), plan, DEFAULT_VALIDITY_MS)).approved).toBe(true);
    });

    it("the plan age rule still applies and the approver is never asked", async () => {
      const w = setup();
      const plan = await newPlan(w);
      w.clock.advance(MAX_PLAN_AGE_MS + 1);
      const seen: string[] = [];
      await expect(approvePlan(w.approvePorts, dialog("approved", seen), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow(PlanTooOldError);
      expect(seen).toEqual([]);
    });

    it("an approver preflight failure stops everything before the plan age check", async () => {
      const w = setup();
      const plan = await newPlan(w);
      w.clock.advance(MAX_PLAN_AGE_MS + 1);
      const failing: Approver = {
        kind: "os-dialog",
        preflight: () => {
          throw new Error("preflight says no");
        },
        decide: async () => "approved",
      };
      await expect(approvePlan(w.approvePorts, failing, plan, DEFAULT_VALIDITY_MS)).rejects.toThrow("preflight says no");
    });
  });

  describe("refusals write and publish nothing", () => {
    async function expectUntouched(w: World, term: ScriptedTerminal) {
      expect(term.written).toEqual([]);
      expect(term.prompts).toEqual([]);
      expect(w.approvals.size).toBe(0);
      expect(w.vault.key).toBeNull();
      expect((await w.audit.logged()).map((e) => e.name)).toEqual(["plan-created"]);
    }

    it.each([
      ["stdin is not a TTY", { stdinIsTTY: false }],
      ["stdout is not a TTY", { stdoutIsTTY: false }],
      ["neither is a TTY", { stdinIsTTY: false, stdoutIsTTY: false }],
    ])("non-interactive session: %s", async (_n, opts) => {
      const w = setup();
      const plan = await newPlan(w);
      const term = typing(plan, opts);
      await expect(approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow(HumanRequiredError);
      await expect(approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow("approve needs an interactive terminal on stdin and stdout");
      await expectUntouched(w, term);
    });

    it.each(AGENT_ENV_MARKERS)("agent environment marker %s", async (marker) => {
      const w = setup();
      const plan = await newPlan(w);
      const term = typing(plan, { env: { [marker]: "1" } });
      await expect(approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow(`approve refuses to run while ${marker} is set`);
      await expectUntouched(w, term);
    });

    it("a plan older than 24 hours", async () => {
      const w = setup();
      const plan = await newPlan(w);
      w.clock.advance(MAX_PLAN_AGE_MS + 1);
      const term = typing(plan);
      await expect(approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow(PlanTooOldError);
      await expect(approvePlan(w.approvePorts, via(term), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow("the plan is older than 24 hours; create a new one");
      await expectUntouched(w, term);
    });

    it("a plan exactly 24 hours old can still be approved", async () => {
      const w = setup();
      const plan = await newPlan(w);
      w.clock.advance(MAX_PLAN_AGE_MS);
      expect((await approvePlan(w.approvePorts, via(typing(plan)), plan, DEFAULT_VALIDITY_MS)).approved).toBe(true);
    });

    it("the human check comes before the plan age check", async () => {
      const w = setup();
      const plan = await newPlan(w);
      w.clock.advance(MAX_PLAN_AGE_MS + 1);
      await expect(approvePlan(w.approvePorts, via(typing(plan, { stdinIsTTY: false })), plan, DEFAULT_VALIDITY_MS)).rejects.toThrow(HumanRequiredError);
    });

    it("an invalid validity after a correct confirmation issues and publishes nothing", async () => {
      const w = setup();
      const plan = await newPlan(w);
      await expect(approvePlan(w.approvePorts, via(typing(plan)), plan, 0)).rejects.toThrow("approval validity must be between");
      expect(w.approvals.size).toBe(0);
      expect((await w.audit.logged()).map((e) => e.name)).toEqual(["plan-created"]);
    });
  });
});
