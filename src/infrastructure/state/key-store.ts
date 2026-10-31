import { createHmac, randomBytes } from "node:crypto";
import { constants, open } from "node:fs/promises";
import type { KeyStore } from "../../application/ports/planning.js";
import type { Signer } from "../../domain/approval/approval.js";
import { StateError, type State } from "./state-dir.js";

function uid(): number {
  if (typeof process.getuid !== "function") throw new StateError("this platform is not supported (no POSIX user ids)");
  return process.getuid();
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

/** HMAC-SHA256 signer over the per-user key file. */
export function hmacSigner(key: Buffer): Signer {
  return { sign: (message) => createHmac("sha256", key).update(message).digest("hex") };
}

/** KeyStore adapter: the key lives in the state directory with mode 0600. */
export class FileKeyStore implements KeyStore {
  constructor(private readonly state: State) {}

  async signer(create: boolean): Promise<Signer | null> {
    const key = await loadKey(this.state, create);
    return key ? hmacSigner(key) : null;
  }
}
