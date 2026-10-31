import { readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, withLock } from "../../src/infrastructure/fs/file-lock.js";
import { LockHeldError } from "../../src/domain/errors.js";
import { makeSandbox } from "../support/helpers.js";

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

describe("stale lock takeover is atomic", () => {
  const gate = <T = void>() => {
    let open!: (v: T) => void;
    const promise = new Promise<T>((r) => (open = r));
    return { promise, open };
  };

  it("a waiter that judged the lock stale before another process took it over does not remove the new holder's lock", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, lockBody({ pid: deadPid(), host: hostname() }));

    const reachedStale = gate();
    const letBContinue = gate();
    // B reads the stale lock, then stalls before acting on that observation
    const b = acquireLock(path, {
      timeoutMs: 0,
      onStale: async () => {
        reachedStale.open();
        await letBContinue.promise;
      },
    }).then(
      (h) => ({ ok: true as const, h }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await reachedStale.promise;

    // A takes over the stale lock completely and now legitimately holds it
    const a = await acquireLock(path, { timeoutMs: 0 });
    const heldBody = readFileSync(path, "utf8");
    expect(JSON.parse(heldBody)).toMatchObject({ pid: process.pid });

    letBContinue.open();
    const result = await b;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.e).toBeInstanceOf(LockHeldError);
    // A's lock was not unlinked or replaced by B
    expect(readFileSync(path, "utf8")).toBe(heldBody);
    await a.release();
    expect(existsSync(path)).toBe(false);
  });

  it("many waiters racing on one stale lock end with exactly one holder at a time (no lost updates)", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const counter = join(sb.base, "counter");
    writeFileSync(counter, "0");
    writeFileSync(path, lockBody({ pid: deadPid(), host: hostname() }));
    const worker = async () => {
      const h = await acquireLock(path, { timeoutMs: 10_000 });
      const n = Number(readFileSync(counter, "utf8"));
      await new Promise((r) => setTimeout(r, 2));
      writeFileSync(counter, String(n + 1));
      await h.release();
    };
    await Promise.all(Array.from({ length: 25 }, worker));
    expect(readFileSync(counter, "utf8")).toBe("25");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });

  it("a takeover gate abandoned by a crashed process does not block later takeovers", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    writeFileSync(path, lockBody({ pid: deadPid(), host: hostname() }));
    writeFileSync(`${path}.takeover`, "crashed");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.takeover`, old, old);
    const h = await acquireLock(path, { timeoutMs: 5_000 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid });
    await h.release();
  });

  it("a live takeover gate makes a competing waiter wait instead of removing anything", async () => {
    const sb = makeSandbox();
    const path = join(sb.base, "l.lock");
    const stale = lockBody({ pid: deadPid(), host: hostname() });
    writeFileSync(path, stale);
    writeFileSync(`${path}.takeover`, "someone else is taking over");
    await expect(acquireLock(path, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockHeldError);
    expect(readFileSync(path, "utf8")).toBe(stale);
  });
});
