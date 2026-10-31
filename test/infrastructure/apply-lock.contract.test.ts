import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import type { ApplyLock } from "../../src/application/ports/common.js";
import { LockHeldError } from "../../src/domain/errors.js";
import { FileApplyLock } from "../../src/infrastructure/fs/file-lock.js";
import { MemoryApplyLock } from "../support/fakes/memory-stores.js";
import { openSandboxState } from "../support/state.js";

interface Harness {
  /** An ApplyLock instance; every call gives another instance over the same lock storage. */
  open(): ApplyLock;
}

async function memory(): Promise<Harness> {
  const state = { holder: null as symbol | null };
  return { open: () => new MemoryApplyLock(state) };
}

async function file(): Promise<Harness> {
  const { state } = await openSandboxState();
  return { open: () => new FileApplyLock(state.lockPath) };
}

describe.each([
  ["memory", memory],
  ["file", file],
])("ApplyLock contract: %s", (_name, make) => {
  it("acquire returns a lease", async () => {
    const h = await make();
    const lease = await h.open().acquire();
    expect(typeof lease.release).toBe("function");
    await lease.release();
  });

  it("is exclusive: a second acquire rejects with LockHeldError", async () => {
    const h = await make();
    const lease = await h.open().acquire();
    await expect(h.open().acquire()).rejects.toThrow(LockHeldError);
    await lease.release();
  });

  it("is exclusive for the same instance too", async () => {
    const h = await make();
    const lock = h.open();
    const lease = await lock.acquire();
    await expect(lock.acquire()).rejects.toBeInstanceOf(LockHeldError);
    await lease.release();
  });

  it("the refusal names the problem", async () => {
    const h = await make();
    const lease = await h.open().acquire();
    await expect(h.open().acquire()).rejects.toThrow(/another disk-janitor operation holds the lock/);
    await lease.release();
  });

  it("release frees the lock for the next acquire", async () => {
    const h = await make();
    const first = await h.open().acquire();
    await first.release();
    const second = await h.open().acquire();
    await expect(h.open().acquire()).rejects.toThrow(LockHeldError);
    await second.release();
  });

  it("can be acquired and released repeatedly", async () => {
    const h = await make();
    const lock = h.open();
    for (let i = 0; i < 5; i++) await (await lock.acquire()).release();
  });

  it("releasing twice is harmless and does not free a lock someone else took", async () => {
    const h = await make();
    const first = await h.open().acquire();
    await first.release();
    const second = await h.open().acquire();
    await expect(first.release()).resolves.toBeUndefined();
    await expect(h.open().acquire()).rejects.toThrow(LockHeldError);
    await second.release();
    await (await h.open().acquire()).release();
  });

  it("a failed acquire does not disturb the holder", async () => {
    const h = await make();
    const lease = await h.open().acquire();
    await expect(h.open().acquire()).rejects.toThrow(LockHeldError);
    await expect(h.open().acquire()).rejects.toThrow(LockHeldError);
    await lease.release();
    await (await h.open().acquire()).release();
  });

  it("only one of several concurrent acquirers wins", async () => {
    const h = await make();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.open().acquire()));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockHeldError);
    for (const r of results) if (r.status === "fulfilled") await r.value.release();
  });
});

describe("FileApplyLock on disk", () => {
  it("creates the lock file with mode 0600 while held and removes it on release", async () => {
    const { state } = await openSandboxState();
    const lease = await new FileApplyLock(state.lockPath).acquire();
    expect(existsSync(state.lockPath)).toBe(true);
    const body = JSON.parse(readFileSync(state.lockPath, "utf8")) as { pid: number; host: string };
    expect(body.pid).toBe(process.pid);
    expect(body.host).toBe(hostname());
    await lease.release();
    expect(existsSync(state.lockPath)).toBe(false);
  });

  it("steals a lock left by a process on this host that no longer exists", async () => {
    const { state } = await openSandboxState();
    writeFileSync(state.lockPath, JSON.stringify({ pid: 2_000_000_000, host: hostname(), token: "dead", since: "2020-01-01T00:00:00.000Z" }));
    const lease = await new FileApplyLock(state.lockPath).acquire();
    expect(JSON.parse(readFileSync(state.lockPath, "utf8")).pid).toBe(process.pid);
    await lease.release();
  });

  it("treats a lock from another host as held even when the pid does not exist here", async () => {
    const { state } = await openSandboxState();
    writeFileSync(state.lockPath, JSON.stringify({ pid: 2_000_000_000, host: "some-other-host.invalid", token: "x", since: "2020-01-01T00:00:00.000Z" }));
    await expect(new FileApplyLock(state.lockPath).acquire()).rejects.toThrow(LockHeldError);
    expect(existsSync(state.lockPath)).toBe(true);
  });

  it("treats a fresh unreadable lock file as held", async () => {
    const { state } = await openSandboxState();
    writeFileSync(state.lockPath, "{half");
    await expect(new FileApplyLock(state.lockPath).acquire()).rejects.toThrow(LockHeldError);
  });

  it("release leaves a lock file that was replaced by another holder alone", async () => {
    const { state } = await openSandboxState();
    const lease = await new FileApplyLock(state.lockPath).acquire();
    writeFileSync(state.lockPath, JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else", since: "now" }));
    await lease.release();
    expect(JSON.parse(readFileSync(state.lockPath, "utf8")).token).toBe("someone-else");
  });
});
