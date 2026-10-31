import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isInside } from "../../domain/shared/paths.js";

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
