import { readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, LockHeldError, withLock } from "../src/lock.js";
import { makeSandbox } from "./helpers.js";

function deadPid(): number {
  for (let pid = 2 ** 22; pid > 1000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid found");
}

const lockBody = (o: Record<string, unknown>) => JSON.stringify({ since: "x", token: "t", ...o });

describe("acquireLock", () => {
  it("creates a mode-0600 lock file containing pid, host and token", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    const body = JSON.parse(readFileSync(path, "utf8")) as { pid: number; host: string; token: string };
    expect(body.pid).toBe(process.pid);
    expect(body.host).toBe(hostname());
    expect(body.token).toMatch(/^[0-9a-f]{16}$/);
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await h.release();
    expect(existsSync(path)).toBe(false);
  });

  it("is exclusive: a second acquire with timeoutMs 0 throws LockHeldError", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
    await expect(acquireLock(path)).rejects.toThrow(/holds the lock/);
    await h.release();
    const h2 = await acquireLock(path);
    await h2.release();
  });

  it("release removes only its own token", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    const replaced = lockBody({ pid: process.pid, host: hostname(), token: "someone-else" });
    writeFileSync(path, replaced);
    await h.release();
    expect(readFileSync(path, "utf8")).toBe(replaced);
  });

  it("release is idempotent and tolerates a missing file", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    await h.release();
    await expect(h.release()).resolves.toBeUndefined();
  });

  it("steals a stale lock from a dead pid on this host", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, lockBody({ pid: deadPid(), host: hostname() }));
    const h = await acquireLock(path);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
    await h.release();
  });

  it("does not steal a lock held by a live pid (this process)", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const body = lockBody({ pid: process.pid, host: hostname() });
    writeFileSync(path, body);
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  it("does not steal a lock from a dead pid on another host", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, lockBody({ pid: deadPid(), host: hostname() + "-other" }));
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
  });

  it("treats a corrupt young lock file as held", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, "{half-writ");
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
    expect(readFileSync(path, "utf8")).toBe("{half-writ");
  });

  it("steals a corrupt lock file older than 60 s", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, "garbage");
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);
    const h = await acquireLock(path);
    await h.release();
  });

  it("does not steal when pid is not a number", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, lockBody({ pid: "123", host: hostname() }));
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
  });

  it("waits and succeeds when the holder releases within the timeout", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    setTimeout(() => void h.release(), 150);
    const t0 = Date.now();
    const h2 = await acquireLock(path, { timeoutMs: 3000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    await h2.release();
  });

  it("gives up after the timeout when the holder never releases", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    const t0 = Date.now();
    await expect(acquireLock(path, { timeoutMs: 120 })).rejects.toBeInstanceOf(LockHeldError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    await h.release();
  });

  it("propagates errors other than EEXIST (missing directory)", async () => {
    const sb = makeSandbox();
    await expect(acquireLock(join(sb.base, "nope", "l.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent critical sections", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withLock(path, 10_000, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 10));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});

describe("withLock", () => {
  it("returns the value and releases", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    expect(await withLock(path, 0, async () => 42)).toBe(42);
    expect(existsSync(path)).toBe(false);
  });

  it("releases on throw and rethrows the original error", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    await expect(
      withLock(path, 0, async () => {
        expect(existsSync(path)).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });

  it("does not run the callback when the lock is held", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const h = await acquireLock(path);
    let ran = false;
    await expect(withLock(path, 0, async () => void (ran = true))).rejects.toBeInstanceOf(LockHeldError);
    expect(ran).toBe(false);
    expect(existsSync(path)).toBe(true);
    await h.release();
  });
});
