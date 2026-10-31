import { randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import type { ApplyLock, Lease } from "../../application/ports/common.js";
import { LockHeldError } from "../../domain/errors.js";

export type LockHandle = Lease;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const GATE_STALE_MS = 5_000;
const BODY_STALE_MS = 60_000;

/** Is the lock file at `path` abandoned? A dead pid on this host, or an unreadable body older than a minute. */
async function isStale(path: string): Promise<boolean> {
  try {
    const cur = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; host?: unknown };
    return typeof cur.pid === "number" && cur.host === hostname() && !alive(cur.pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // unreadable or half-written: stale only when old
    try {
      return Date.now() - (await stat(path)).mtimeMs > BODY_STALE_MS;
    } catch {
      return false;
    }
  }
}

/**
 * Remove an abandoned lock without ever removing a live one. Only the holder of the takeover gate
 * (`<path>.takeover`, created with O_EXCL) may unlink the lock, and it re-checks staleness inside
 * the gate: a waiter that judged the lock stale earlier, while someone else completed a takeover in
 * the meantime, finds a live lock and leaves it alone. A gate left behind by a crashed process is
 * removed once it is older than a few seconds.
 */
async function removeStaleLock(path: string): Promise<boolean> {
  const gate = `${path}.takeover`;
  let fh;
  try {
    fh = await open(gate, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      if (Date.now() - (await stat(gate)).mtimeMs > GATE_STALE_MS) await unlink(gate);
    } catch {
      // someone else removed it
    }
    return false;
  }
  try {
    await fh.close();
    if (!(await isStale(path))) return false;
    await unlink(path).catch(() => undefined);
    return true;
  } finally {
    await unlink(gate).catch(() => undefined);
  }
}

/**
 * Exclusive lock file (created with O_EXCL). A lock left by a process on this host that no longer
 * exists is taken over atomically (see removeStaleLock); anything else counts as held. timeoutMs 0
 * fails immediately.
 */
export interface AcquireOptions {
  timeoutMs?: number;
  /** Test seam: awaited after a lock was judged stale and before anything is done about it. */
  onStale?: () => Promise<void>;
}

export async function acquireLock(path: string, opts: AcquireOptions = {}): Promise<LockHandle> {
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: process.pid, host: hostname(), token, since: new Date().toISOString() });
  for (;;) {
    try {
      const fh = await open(path, "wx", 0o600);
      try {
        await fh.writeFile(body);
      } finally {
        await fh.close();
      }
      return {
        async release() {
          try {
            const cur = JSON.parse(await readFile(path, "utf8")) as { token?: string };
            if (cur.token === token) await unlink(path);
          } catch {
            // already gone or replaced
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (await isStale(path)) {
      await opts.onStale?.();
      if (await removeStaleLock(path)) continue;
    }
    if (Date.now() >= deadline) throw new LockHeldError(`another disk-janitor operation holds the lock (${path})`);
    await sleep(25);
  }
}

export async function withLock<T>(path: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLock(path, { timeoutMs });
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/** ApplyLock adapter over an exclusive lock file; fails immediately when the lock is held. */
export class FileApplyLock implements ApplyLock {
  constructor(private readonly path: string) {}

  acquire(): Promise<Lease> {
    return acquireLock(this.path, { timeoutMs: 0 });
  }
}
