import { randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockHeldError";
  }
}

export interface LockHandle {
  release(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive lock file (created with O_EXCL). A lock left by a process on this host that no longer
 * exists is stolen; anything else counts as held. timeoutMs 0 fails immediately.
 */
export async function acquireLock(path: string, opts: { timeoutMs?: number } = {}): Promise<LockHandle> {
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
    let stale = false;
    try {
      const text = await readFile(path, "utf8");
      const cur = JSON.parse(text) as { pid?: unknown; host?: unknown };
      stale = typeof cur.pid === "number" && cur.host === hostname() && !alive(cur.pid);
    } catch {
      // unreadable or half-written: stale only when old
      try {
        stale = Date.now() - (await stat(path)).mtimeMs > 60_000;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      await unlink(path).catch(() => undefined);
      continue;
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
