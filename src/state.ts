import { randomBytes } from "node:crypto";
import { chmod, constants, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isInside } from "./domain/shared/paths.js";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export interface State {
  dir: string;
  keyPath: string;
  plansDir: string;
  approvalsDir: string;
  quarantineDir: string;
  auditPath: string;
  auditLockPath: string;
  lockPath: string;
}

function uid(): number {
  if (typeof process.getuid !== "function") throw new StateError("this platform is not supported (no POSIX user ids)");
  return process.getuid();
}

async function checkDir(path: string, what: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new StateError(`${what} is a symlink: ${path}`);
  if (!st.isDirectory()) throw new StateError(`${what} is not a directory: ${path}`);
  if (st.uid !== uid()) throw new StateError(`${what} is not owned by the current user: ${path}`);
  if ((st.mode & 0o022) !== 0) throw new StateError(`${what} is group- or world-writable: ${path}`);
}

async function ensureDir(path: string, what: string): Promise<void> {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  await checkDir(path, what);
}

/**
 * Create (0700) or validate the state directory. Refuses a symlink, a directory owned by someone
 * else, a group/world-writable one, and any state directory inside a root (or containing one).
 */
export async function openState(stateDir: string, roots: readonly string[]): Promise<State> {
  const abs = resolve(stateDir);
  await ensureDir(abs, "state directory");
  const real = await realpath(abs);
  for (const root of roots) {
    if (isInside(root, real) || isInside(real, root)) {
      throw new StateError("the state directory must not be inside a configured root (or contain one)");
    }
  }
  const state: State = {
    dir: real,
    keyPath: join(real, "key"),
    plansDir: join(real, "plans"),
    approvalsDir: join(real, "approvals"),
    quarantineDir: join(real, "quarantine"),
    auditPath: join(real, "audit.jsonl"),
    auditLockPath: join(real, "audit.lock"),
    lockPath: join(real, "apply.lock"),
  };
  await ensureDir(state.plansDir, "plans directory");
  await ensureDir(state.approvalsDir, "approvals directory");
  await ensureDir(state.quarantineDir, "quarantine directory");
  return state;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The per-user HMAC key (32 random bytes, hex, mode 0600). With `create` the key is generated on
 * first use with O_EXCL; otherwise a missing key yields null. A key file with group/other access,
 * a foreign owner or a symlink is refused.
 */
export async function loadKey(state: State, create: boolean): Promise<Buffer | null> {
  if (create) {
    try {
      const fh = await open(state.keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        await fh.writeFile(randomBytes(32).toString("hex") + "\n");
      } finally {
        await fh.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  let fh;
  try {
    fh = await open(state.keyPath, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new StateError("key file is a symlink");
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new StateError("key file is not a regular file");
    if (st.uid !== uid()) throw new StateError("key file is not owned by the current user");
    if ((st.mode & 0o077) !== 0) throw new StateError("key file must be mode 0600; refusing to use it");
    if (st.size < 64 || st.size > 256) throw new StateError("key file has an unexpected size");
    const text = (await fh.readFile("utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new StateError("key file is corrupt");
    return Buffer.from(text, "hex");
  } finally {
    await fh.close();
  }
}
