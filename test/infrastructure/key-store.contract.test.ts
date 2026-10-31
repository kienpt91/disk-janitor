import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KeyStore } from "../../src/application/ports/planning.js";
import { FileKeyStore } from "../../src/infrastructure/state/key-store.js";
import { MemoryKeyStore } from "../support/fakes/memory-stores.js";
import { openSandboxState } from "../support/state.js";

interface Harness {
  /** A store instance over the shared storage. Calling it again gives another instance over the same storage. */
  open(): KeyStore;
  /** A store over different, empty storage. */
  independent(): Promise<KeyStore>;
}

async function memory(): Promise<Harness> {
  const vault = { key: null as string | null };
  return {
    open: () => new MemoryKeyStore(vault),
    independent: async () => new MemoryKeyStore({ key: null }, () => "an-independent-key"),
  };
}

async function file(): Promise<Harness> {
  const { state } = await openSandboxState();
  return {
    open: () => new FileKeyStore(state),
    independent: async () => new FileKeyStore((await openSandboxState()).state),
  };
}

const MESSAGES = ["disk-janitor/approval/v1\napply\nplan\ndigest", "", "another message", "ünïcode ✓"];

describe.each([
  ["memory", memory],
  ["file", file],
])("KeyStore contract: %s", (_name, make) => {
  it("signer(false) is null until a key was created", async () => {
    const h = await make();
    expect(await h.open().signer(false)).toBeNull();
    expect(await h.open().signer(false)).toBeNull();
  });

  it("signer(true) creates the key and returns a signer", async () => {
    const h = await make();
    const signer = await h.open().signer(true);
    expect(signer).not.toBeNull();
    expect(signer?.sign("m")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("after creation signer(false) returns a signer, from any instance", async () => {
    const h = await make();
    await h.open().signer(true);
    expect(await h.open().signer(false)).not.toBeNull();
  });

  it("signer(false) never creates the key", async () => {
    const h = await make();
    await h.open().signer(false);
    expect(await h.open().signer(false)).toBeNull();
  });

  it("the same key signs identically across instances and across repeated creation", async () => {
    const h = await make();
    const a = await h.open().signer(true);
    const b = await h.open().signer(false);
    const c = await h.open().signer(true);
    for (const m of MESSAGES) {
      expect(a?.sign(m)).toBe(b?.sign(m));
      expect(a?.sign(m)).toBe(c?.sign(m));
    }
  });

  it("signing is deterministic and depends on the message", async () => {
    const h = await make();
    const s = await h.open().signer(true);
    expect(s?.sign("m")).toBe(s?.sign("m"));
    const sigs = new Set(MESSAGES.map((m) => s?.sign(m)));
    expect(sigs.size).toBe(MESSAGES.length);
  });

  it("a different key signs differently", async () => {
    const h = await make();
    const a = await h.open().signer(true);
    const b = await (await h.independent()).signer(true);
    for (const m of MESSAGES) expect(a?.sign(m)).not.toBe(b?.sign(m));
  });
});

describe("FileKeyStore on disk", () => {
  it("creates the key file with mode 0600 and 64 hex characters", async () => {
    const { state } = await openSandboxState();
    await new FileKeyStore(state).signer(true);
    expect(statSync(state.keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(state.keyPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not replace an existing key when asked to create again", async () => {
    const { state } = await openSandboxState();
    await new FileKeyStore(state).signer(true);
    const before = readFileSync(state.keyPath, "utf8");
    await new FileKeyStore(state).signer(true);
    expect(readFileSync(state.keyPath, "utf8")).toBe(before);
  });

  it.each([0o644, 0o640, 0o604, 0o660, 0o666])("refuses a key file with mode %o", async (mode) => {
    const { state } = await openSandboxState();
    const store = new FileKeyStore(state);
    await store.signer(true);
    chmodSync(state.keyPath, mode);
    await expect(store.signer(false)).rejects.toThrow("key file must be mode 0600; refusing to use it");
    await expect(store.signer(true)).rejects.toThrow("key file must be mode 0600");
  });

  it("accepts mode 0400", async () => {
    const { state } = await openSandboxState();
    const store = new FileKeyStore(state);
    const sig = (await store.signer(true))?.sign("m");
    chmodSync(state.keyPath, 0o400);
    expect((await store.signer(false))?.sign("m")).toBe(sig);
  });

  it("refuses a key file that is a symlink", async () => {
    const { sb, state } = await openSandboxState();
    const target = join(sb.base, "real-key");
    writeFileSync(target, "a".repeat(64) + "\n", { mode: 0o600 });
    symlinkSync(target, state.keyPath);
    await expect(new FileKeyStore(state).signer(false)).rejects.toThrow("key file is a symlink");
  });

  it("refuses a corrupt key file", async () => {
    const { state } = await openSandboxState();
    writeFileSync(state.keyPath, "z".repeat(64) + "\n", { mode: 0o600 });
    await expect(new FileKeyStore(state).signer(false)).rejects.toThrow("key file is corrupt");
  });

  it("refuses a key file of unexpected size", async () => {
    const { state } = await openSandboxState();
    writeFileSync(state.keyPath, "ab\n", { mode: 0o600 });
    await expect(new FileKeyStore(state).signer(false)).rejects.toThrow("key file has an unexpected size");
  });

  it("a key written by hand signs the same as the HMAC of its bytes", async () => {
    const { state } = await openSandboxState();
    const hex = "0123456789abcdef".repeat(4);
    writeFileSync(state.keyPath, hex + "\n", { mode: 0o600 });
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", Buffer.from(hex, "hex")).update("hello").digest("hex");
    expect((await new FileKeyStore(state).signer(false))?.sign("hello")).toBe(expected);
  });
});
