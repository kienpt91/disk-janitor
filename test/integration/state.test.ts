import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKey } from "../../src/infrastructure/state/key-store.js";
import { openState, StateError } from "../../src/infrastructure/state/state-dir.js";
import { makeSandbox } from "../support/helpers.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("openState", () => {
  it("creates the dir 0700 with plans/approvals/quarantine subdirs", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    expect(s.dir).toBe(sb.state);
    expect(mode(sb.state)).toBe(0o700);
    for (const d of [s.plansDir, s.approvalsDir, s.quarantineDir]) {
      expect(statSync(d).isDirectory()).toBe(true);
      expect(mode(d)).toBe(0o700);
    }
    expect(s.plansDir).toBe(join(sb.state, "plans"));
    expect(s.approvalsDir).toBe(join(sb.state, "approvals"));
    expect(s.quarantineDir).toBe(join(sb.state, "quarantine"));
    expect(s.keyPath).toBe(join(sb.state, "key"));
    expect(s.auditPath).toBe(join(sb.state, "audit.jsonl"));
    expect(s.lockPath).toBe(join(sb.state, "apply.lock"));
  });

  it("creates missing parent directories", async () => {
    const sb = makeSandbox();
    const s = await openState(join(sb.base, "a", "b", "state"), [sb.projects]);
    expect(mode(s.dir)).toBe(0o700);
  });

  it("reopens an existing valid state dir and keeps its content", async () => {
    const sb = makeSandbox();
    const a = await openState(sb.state, [sb.projects]);
    writeFileSync(join(a.plansDir, "keep.json"), "{}");
    const b = await openState(sb.state, [sb.projects]);
    expect(b).toEqual(a);
    expect(readFileSync(join(b.plansDir, "keep.json"), "utf8")).toBe("{}");
  });

  it("refuses a symlinked state dir", async () => {
    const sb = makeSandbox();
    const real = join(sb.base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, sb.state);
    await expect(openState(sb.state, [sb.projects])).rejects.toThrow(/symlink/);
  });

  for (const m of [0o777, 0o770, 0o720, 0o702]) {
    it(`refuses a state dir with mode ${m.toString(8)}`, async () => {
      const sb = makeSandbox();
      mkdirSync(sb.state);
      chmodSync(sb.state, m);
      await expect(openState(sb.state, [sb.projects])).rejects.toThrow(/group- or world-writable/);
    });
  }

  it("accepts a 0750 state dir (not writable by others)", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.state);
    chmodSync(sb.state, 0o750);
    await expect(openState(sb.state, [sb.projects])).resolves.toBeDefined();
  });

  it("refuses a group-writable subdirectory", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    chmodSync(s.approvalsDir, 0o770);
    await expect(openState(sb.state, [sb.projects])).rejects.toThrow(/approvals directory is group- or world-writable/);
  });

  it("refuses a symlinked subdirectory", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.state, { mode: 0o700 });
    const elsewhere = join(sb.base, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(sb.state, "quarantine"));
    await expect(openState(sb.state, [sb.projects])).rejects.toThrow(/quarantine directory is a symlink/);
  });

  it("refuses a state path that is a regular file", async () => {
    const sb = makeSandbox();
    writeFileSync(sb.state, "x");
    await expect(openState(sb.state, [sb.projects])).rejects.toThrow(/not a directory/);
  });

  it("refuses a state dir inside a root", async () => {
    const sb = makeSandbox();
    await expect(openState(join(sb.projects, ".dj-state"), [sb.projects])).rejects.toThrow(/must not be inside a configured root/);
  });

  it("refuses a state dir equal to a root", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.state, { mode: 0o700 });
    await expect(openState(sb.state, [sb.state])).rejects.toBeInstanceOf(StateError);
  });

  it("refuses a state dir that contains a root", async () => {
    const sb = makeSandbox();
    await expect(openState(sb.base, [sb.projects])).rejects.toThrow(/or contain one/);
  });

  it("refuses a state dir reached through a symlink into a root", async () => {
    const sb = makeSandbox();
    const link = join(sb.base, "link");
    symlinkSync(sb.projects, link);
    await expect(openState(link, [sb.projects])).rejects.toThrow(/symlink/);
  });

  it("does not treat a sibling with a common name prefix as inside the root", async () => {
    const sb = makeSandbox();
    await expect(openState(sb.projects + "-state", [sb.projects])).resolves.toBeDefined();
  });
});

describe("loadKey", () => {
  it("returns null when absent and create is false (and creates nothing)", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    expect(await loadKey(s, false)).toBeNull();
    expect(() => statSync(s.keyPath)).toThrow();
  });

  it("creates a 64-hex key with mode 0600 and returns the same key later", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    const k1 = await loadKey(s, true);
    expect(k1).toHaveLength(32);
    expect(mode(s.keyPath)).toBe(0o600);
    expect(readFileSync(s.keyPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    const k2 = await loadKey(s, true);
    const k3 = await loadKey(s, false);
    expect(k2?.equals(k1 as Buffer)).toBe(true);
    expect(k3?.equals(k1 as Buffer)).toBe(true);
  });

  it("generates different keys for different state dirs", async () => {
    const a = makeSandbox();
    const b = makeSandbox();
    const ka = await loadKey(await openState(a.state, [a.projects]), true);
    const kb = await loadKey(await openState(b.state, [b.projects]), true);
    expect(ka?.equals(kb as Buffer)).toBe(false);
  });

  for (const m of [0o644, 0o640, 0o604, 0o660]) {
    it(`refuses a key file with mode ${m.toString(8)}`, async () => {
      const sb = makeSandbox();
      const s = await openState(sb.state, [sb.projects]);
      await loadKey(s, true);
      chmodSync(s.keyPath, m);
      await expect(loadKey(s, false)).rejects.toThrow(/mode 0600/);
      await expect(loadKey(s, true)).rejects.toThrow(/mode 0600/);
    });
  }

  it("refuses a key that is a symlink", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    const target = join(sb.base, "other-key");
    writeFileSync(target, "a".repeat(64) + "\n", { mode: 0o600 });
    symlinkSync(target, s.keyPath);
    await expect(loadKey(s, false)).rejects.toThrow(/symlink/);
    await expect(loadKey(s, true)).rejects.toThrow(/symlink/);
  });

  it("refuses a key file of the wrong size", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    writeFileSync(s.keyPath, "abcd\n", { mode: 0o600 });
    await expect(loadKey(s, false)).rejects.toThrow(/unexpected size/);
    writeFileSync(s.keyPath, "a".repeat(300), { mode: 0o600 });
    await expect(loadKey(s, false)).rejects.toThrow(/unexpected size/);
  });

  it("refuses corrupt key content of the right size", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    writeFileSync(s.keyPath, "z".repeat(64) + "\n", { mode: 0o600 });
    await expect(loadKey(s, false)).rejects.toThrow(/corrupt/);
    writeFileSync(s.keyPath, "A".repeat(64) + "\n", { mode: 0o600 });
    await expect(loadKey(s, false)).rejects.toThrow(/corrupt/);
  });

  it("refuses a key path that is a directory", async () => {
    const sb = makeSandbox();
    const s = await openState(sb.state, [sb.projects]);
    mkdirSync(s.keyPath, { mode: 0o700 });
    await expect(loadKey(s, false)).rejects.toThrow();
  });
});
