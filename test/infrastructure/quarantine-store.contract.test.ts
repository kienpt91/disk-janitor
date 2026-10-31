// One contract for every QuarantineStore: the in-memory fake used by application tests and the real
// file adapter must behave identically. The real adapter runs in a temp directory.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSystem } from "../../src/application/ports/common.js";
import type { QuarantineStore } from "../../src/application/ports/quarantine.js";
import { nodeFs } from "../../src/infrastructure/fs/node-fs.js";
import { FileKeyStore } from "../../src/infrastructure/state/key-store.js";
import { FileQuarantineStore } from "../../src/infrastructure/state/quarantine-store.js";
import { openState } from "../../src/infrastructure/state/state-dir.js";
import { QuarantineError } from "../../src/domain/quarantine/errors.js";
import { Manifest } from "../../src/domain/quarantine/manifest.js";
import { makeSandbox } from "../support/helpers.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";
import { MemoryQuarantineStore } from "../support/fakes/memory-quarantine.js";
import { MemoryKeyStore, type KeyVault } from "../support/fakes/memory-stores.js";
import { candidate } from "../support/domain-fixtures.js";

const PLAN_A = "plan-20260101T000000Z-aaaaaaaa";
const PLAN_B = "plan-20260101T000000Z-bbbbbbbb";
const ROOT = "/home/u/projects";

interface World {
  store: QuarantineStore;
  fs: FileSystem;
  root: string;
  /** Put a stored item (a directory with a file) where the store says it lives. */
  makeItem(planId: string, stored: string): void;
  itemExists(planId: string, stored: string): boolean;
  /** Replace an item by a symlink to `target` (a directory the test created). */
  linkItem(planId: string, stored: string, target: string): void;
  makeTarget(path: string): void;
  targetExists(path: string): boolean;
  /** Create an arbitrary directory below the root. */
  makeRootEntry(name: string): void;
  /** Change one stored value of a sealed manifest without the key. */
  corrupt(planId: string): void;
  /** Copy the stored manifest of one plan to another. */
  copyManifest(from: string, to: string): void;
  dropKey(): void;
  replaceKey(): void;
  /** A store of the same kind whose root directory does not exist. */
  storeWithMissingRoot(): QuarantineStore;
}

function memoryWorld(): World {
  const fs = new MemoryFileSystem().mkdir("/state/quarantine");
  const vault: KeyVault = { key: "key-one" };
  const keys = new MemoryKeyStore(vault);
  const store = new MemoryQuarantineStore(fs, "/state/quarantine", keys);
  return {
    storeWithMissingRoot: () => new MemoryQuarantineStore(fs, "/state/nope", keys),
    store,
    fs,
    root: "/state/quarantine",
    makeItem: (p, s) => void fs.writeFile(`${store.itemPath(p, s)}/data.txt`),
    itemExists: (p, s) => fs.exists(store.itemPath(p, s)),
    linkItem: (p, s, target) => {
      fs.remove(store.itemPath(p, s));
      fs.symlink(store.itemPath(p, s), target);
    },
    makeTarget: (path) => void fs.writeFile(`${path}/precious.txt`),
    targetExists: (path) => fs.exists(`${path}/precious.txt`),
    makeRootEntry: (name) => void fs.mkdir(`/state/quarantine/${name}`),
    corrupt: (p) => store.texts.set(p, (store.texts.get(p) as string).replace('"size": 4096', '"size": 1')),
    copyManifest: (from, to) => store.texts.set(to, store.texts.get(from) as string),
    dropKey: () => void (vault.key = null),
    replaceKey: () => void (vault.key = "key-two"),
  };
}

async function realWorld(): Promise<World> {
  const sb = makeSandbox();
  const state = await openState(sb.state, [sb.projects]);
  const keys = new FileKeyStore(state);
  await keys.signer(true);
  const store = new FileQuarantineStore(state.quarantineDir, keys);
  const manifestFile = (p: string) => join(state.quarantineDir, p, "manifest.json");
  return {
    storeWithMissingRoot: () => new FileQuarantineStore(join(state.quarantineDir, "nope"), keys),
    store,
    fs: nodeFs,
    root: state.quarantineDir,
    makeItem: (p, s) => {
      mkdirSync(store.itemPath(p, s), { recursive: true });
      writeFileSync(join(store.itemPath(p, s), "data.txt"), "x");
    },
    itemExists: (p, s) => existsSync(store.itemPath(p, s)),
    linkItem: (p, s, target) => {
      rmSync(store.itemPath(p, s), { recursive: true });
      symlinkSync(target, store.itemPath(p, s));
    },
    makeTarget: (path) => {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "precious.txt"), "keep");
    },
    targetExists: (path) => existsSync(join(path, "precious.txt")),
    makeRootEntry: (name) => void mkdirSync(join(state.quarantineDir, name)),
    corrupt: (p) => writeFileSync(manifestFile(p), readFileSync(manifestFile(p), "utf8").replace('"size": 4096', '"size": 1')),
    copyManifest: (from, to) => writeFileSync(manifestFile(to), readFileSync(manifestFile(from), "utf8")),
    dropKey: () => rmSync(state.keyPath),
    replaceKey: () => {
      writeFileSync(state.keyPath, "f".repeat(64) + "\n");
      chmodSync(state.keyPath, 0o600);
    },
  };
}

function manifest(planId = PLAN_A, count = 2): Manifest {
  return Manifest.create({
    planId,
    planDigest: "d".repeat(64),
    createdAt: 5_000,
    roots: [ROOT],
    home: "/home/u",
    detectors: ["node-modules"],
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
  });
}

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
  return undefined;
};

const adapters: Array<[string, () => World | Promise<World>]> = [
  ["in-memory fake", memoryWorld],
  ["file adapter", realWorld],
];

describe.each(adapters)("QuarantineStore contract: %s", (_name, make) => {
  describe("layout", () => {
    it("keeps <root>/<planId>/items/NNNN", async () => {
      const { store, root } = await make();
      expect(store.rootDir).toBe(root);
      expect(store.planDir(PLAN_A)).toBe(join(root, PLAN_A));
      expect(store.itemsDir(PLAN_A)).toBe(join(root, PLAN_A, "items"));
      expect(store.itemPath(PLAN_A, "0007")).toBe(join(root, PLAN_A, "items", "0007"));
    });

    it("refuses ids and stored names that could leave the quarantine", async () => {
      const { store } = await make();
      for (const bad of ["../x", "", "plan-1", `${PLAN_A}/..`]) expect(() => store.planDir(bad)).toThrow(QuarantineError);
      for (const bad of ["../../x", "1", "abcd", "00 01", ""]) expect(() => store.itemPath(PLAN_A, bad)).toThrow("invalid stored item name");
    });
  });

  describe("create and discard", () => {
    it("create makes the plan directory and an empty items directory on one device", async () => {
      const { store, fs } = await make();
      await store.create(PLAN_A);
      const plan = await fs.lstat(store.planDir(PLAN_A));
      const items = await fs.lstat(store.itemsDir(PLAN_A));
      expect(plan.isDirectory() && items.isDirectory()).toBe(true);
      expect(items.dev).toBe(plan.dev);
      expect(await fs.readdir(store.itemsDir(PLAN_A))).toEqual([]);
    });

    it("create rejects when the plan directory already exists (EEXIST) and leaves it alone", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      w.makeItem(PLAN_A, "0001");
      expect(await code(w.store.create(PLAN_A))).toBe("EEXIST");
      expect(w.itemExists(PLAN_A, "0001")).toBe(true);
    });

    it("create needs a valid plan id", async () => {
      const { store } = await make();
      await expect(store.create("nope")).rejects.toThrow(QuarantineError);
    });

    it("discard removes the empty directories of a plan that was never applied", async () => {
      const { store, fs } = await make();
      await store.create(PLAN_A);
      await store.discard(PLAN_A);
      expect(await store.planIds()).toEqual([]);
      await expect(fs.lstat(store.planDir(PLAN_A))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("discard never removes anything that holds items, and never throws", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      w.makeItem(PLAN_A, "0001");
      await expect(w.store.discard(PLAN_A)).resolves.toBeUndefined();
      expect(w.itemExists(PLAN_A, "0001")).toBe(true);
      await expect(w.store.discard(PLAN_B)).resolves.toBeUndefined();
    });
  });

  describe("planIds", () => {
    it("is empty for an empty root and lists every entry (unfiltered)", async () => {
      const w = await make();
      expect(await w.store.planIds()).toEqual([]);
      await w.store.create(PLAN_B);
      await w.store.create(PLAN_A);
      w.makeRootEntry("stray");
      expect([...(await w.store.planIds())].sort()).toEqual([PLAN_A, PLAN_B, "stray"]);
    });

    it("is empty when the root does not exist", async () => {
      const w = await make();
      expect(await w.storeWithMissingRoot().planIds()).toEqual([]);
    });
  });

  describe("manifests", () => {
    it("load is null for a plan without a manifest", async () => {
      const w = await make();
      expect(await w.store.load(PLAN_A)).toBeNull();
      await w.store.create(PLAN_A);
      expect(await w.store.load(PLAN_A)).toBeNull();
    });

    it("a saved manifest loads back equal, and save replaces the previous one", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      const m = manifest();
      await w.store.save(m);
      expect((await w.store.load(PLAN_A))?.toBody()).toEqual(m.toBody());
      const moved = m.markQuarantined(1, 6_000);
      await w.store.save(moved);
      expect((await w.store.load(PLAN_A))?.toBody()).toEqual(moved.toBody());
    });

    it("manifests of different plans do not interfere", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await w.store.create(PLAN_B);
      await w.store.save(manifest(PLAN_A, 1));
      await w.store.save(manifest(PLAN_B, 3));
      expect((await w.store.load(PLAN_A))?.entries).toHaveLength(1);
      expect((await w.store.load(PLAN_B))?.entries).toHaveLength(3);
    });

    it("save needs the plan directory to exist", async () => {
      const w = await make();
      await expect(w.store.save(manifest())).rejects.toBeTruthy();
      expect(await w.store.load(PLAN_A)).toBeNull();
    });

    it("save creates the signing key when none exists yet", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      w.dropKey();
      await w.store.save(manifest());
      expect((await w.store.load(PLAN_A))?.planId).toBe(PLAN_A);
    });

    it("a manifest edited without the key is rejected as modified", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await w.store.save(manifest());
      w.corrupt(PLAN_A);
      await expect(w.store.load(PLAN_A)).rejects.toThrow("manifest signature is invalid: it was modified");
      await expect(w.store.load(PLAN_A)).rejects.toBeInstanceOf(QuarantineError);
    });

    it("a manifest sealed with another key is rejected", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await w.store.save(manifest());
      w.replaceKey();
      await expect(w.store.load(PLAN_A)).rejects.toThrow("manifest signature is invalid: it was modified");
    });

    it("a manifest cannot be authenticated when the key is gone", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await w.store.save(manifest());
      w.dropKey();
      await expect(w.store.load(PLAN_A)).rejects.toThrow("approval key missing: cannot authenticate manifest");
    });

    it("a manifest copied into another plan's directory is refused", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await w.store.create(PLAN_B);
      await w.store.save(manifest(PLAN_A));
      w.copyManifest(PLAN_A, PLAN_B);
      await expect(w.store.load(PLAN_B)).rejects.toThrow("manifest belongs to a different plan");
    });

    it("load needs a valid plan id", async () => {
      const w = await make();
      await expect(w.store.load("../x")).rejects.toThrow("invalid plan id");
    });
  });

  describe("removeItem", () => {
    it("deletes one stored item and nothing else", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      w.makeItem(PLAN_A, "0001");
      w.makeItem(PLAN_A, "0002");
      await w.store.removeItem(PLAN_A, "0001");
      expect(w.itemExists(PLAN_A, "0001")).toBe(false);
      expect(w.itemExists(PLAN_A, "0002")).toBe(true);
    });

    it("removing an item that is already gone succeeds", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      await expect(w.store.removeItem(PLAN_A, "0009")).resolves.toBeUndefined();
    });

    it("an item replaced by a symlink loses the link, never the target", async () => {
      const w = await make();
      await w.store.create(PLAN_A);
      w.makeItem(PLAN_A, "0001");
      const victim = join(w.root, "..", "victim");
      w.makeTarget(victim);
      w.linkItem(PLAN_A, "0001", victim);
      await w.store.removeItem(PLAN_A, "0001");
      expect(w.itemExists(PLAN_A, "0001")).toBe(false);
      expect(w.targetExists(victim)).toBe(true);
    });

    it("refuses a stored name that could leave the items directory", async () => {
      const w = await make();
      await expect(w.store.removeItem(PLAN_A, "../../x")).rejects.toThrow(QuarantineError);
    });
  });
});

describe("FileQuarantineStore on disk (what only the real adapter promises)", () => {
  it("keeps the layout the legacy tool used: manifest.json beside items/, directories private, manifest 0600", async () => {
    const w = await realWorld();
    await w.store.create(PLAN_A);
    await w.store.save(manifest());
    const dir = join(w.root, PLAN_A);
    expect(readdirSync(dir).sort()).toEqual(["items", "manifest.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "items")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("stores readable JSON with a mac and leaves no temporary file behind after repeated saves", async () => {
    const w = await realWorld();
    await w.store.create(PLAN_A);
    let m = manifest();
    await w.store.save(m);
    m = m.markQuarantined(1, 7);
    await w.store.save(m);
    const dir = join(w.root, PLAN_A);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { mac: string; planId: string; entries: Array<{ status: string }> };
    expect(json.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(json.planId).toBe(PLAN_A);
    expect(json.entries.map((e) => e.status)).toEqual(["quarantined", "pending"]);
  });

  it("removeItem really removes a directory tree from disk", async () => {
    const w = await realWorld();
    await w.store.create(PLAN_A);
    mkdirSync(join(w.store.itemPath(PLAN_A, "0001"), "deep", "er"), { recursive: true });
    writeFileSync(join(w.store.itemPath(PLAN_A, "0001"), "deep", "er", "f"), "x");
    await w.store.removeItem(PLAN_A, "0001");
    expect(() => lstatSync(w.store.itemPath(PLAN_A, "0001"))).toThrow();
    expect(dirname(w.store.itemPath(PLAN_A, "0001"))).toBe(w.store.itemsDir(PLAN_A));
    expect(existsSync(w.store.itemsDir(PLAN_A))).toBe(true);
  });
});
