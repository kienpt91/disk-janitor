import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanStore } from "../../src/application/ports/planning.js";
import { MAX_PLAN_BYTES } from "../../src/domain/plan/plan.js";
import { FilePlanStore } from "../../src/infrastructure/state/plan-store.js";
import { openSandboxState } from "../support/state.js";
import { MemoryPlanStore } from "../support/fakes/memory-stores.js";

interface Harness {
  store: PlanStore;
  /** A directory where plans can be written by explicit path. */
  outDir: string;
  /** Put raw text at `path` without going through the store. */
  plant(path: string, text: string): void;
  /** Make `path` a symlink to a regular file with valid-looking content. */
  plantSymlink(path: string): void;
}

async function memory(): Promise<Harness> {
  const store = new MemoryPlanStore();
  return { store, outDir: "/out", plant: (p, t) => store.seed(p, t), plantSymlink: (p) => store.seedSymlink(p) };
}

async function file(): Promise<Harness> {
  const { sb, state } = await openSandboxState();
  const outDir = join(sb.base, "out");
  mkdirSync(outDir);
  return {
    store: new FilePlanStore(state),
    outDir,
    plant: (p, t) => writeFileSync(p, t),
    plantSymlink: (p) => {
      const target = `${p}.target`;
      writeFileSync(target, "{}");
      symlinkSync(target, p);
    },
  };
}

const ID = "plan-20260101T000000Z-0a1b2c3d";
const OTHER_ID = "plan-20260101T000000Z-0a1b2c3e";

describe.each([
  ["memory", memory],
  ["file", file],
])("PlanStore contract: %s", (_name, make) => {
  it("writes by id and reads the same text back by id", async () => {
    const h = await make();
    const path = await h.store.write(ID, '{"a":1}\n');
    expect(path.endsWith(`${ID}.json`)).toBe(true);
    expect(await h.store.read(ID, h.outDir)).toBe('{"a":1}\n');
  });

  it("reading by id does not depend on the working directory", async () => {
    const h = await make();
    await h.store.write(ID, "text");
    expect(await h.store.read(ID, "/")).toBe("text");
    expect(await h.store.read(ID, h.outDir)).toBe("text");
  });

  it("different ids are different plans", async () => {
    const h = await make();
    await h.store.write(ID, "one");
    await h.store.write(OTHER_ID, "two");
    expect(await h.store.read(ID, "/")).toBe("one");
    expect(await h.store.read(OTHER_ID, "/")).toBe("two");
  });

  it("the path returned by write can be used to read the plan", async () => {
    const h = await make();
    const path = await h.store.write(ID, "by path");
    expect(await h.store.read(path, "/")).toBe("by path");
  });

  it("writes to an explicit path and reads it by absolute and relative path", async () => {
    const h = await make();
    const target = join(h.outDir, "my-plan.json");
    expect(await h.store.write(ID, "explicit", target)).toBe(target);
    expect(await h.store.read(target, "/somewhere/else")).toBe("explicit");
    expect(await h.store.read("my-plan.json", h.outDir)).toBe("explicit");
    await expect(h.store.read(ID, h.outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips non-ASCII text", async () => {
    const h = await make();
    await h.store.write(ID, "naïve – 計画 ✓\n");
    expect(await h.store.read(ID, "/")).toBe("naïve – 計画 ✓\n");
  });

  it("refuses to overwrite a plan stored by id and keeps the original", async () => {
    const h = await make();
    await h.store.write(ID, "first");
    await expect(h.store.write(ID, "second")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await h.store.read(ID, "/")).toBe("first");
  });

  it("refuses to overwrite an explicit path and keeps the original", async () => {
    const h = await make();
    const target = join(h.outDir, "p.json");
    await h.store.write(ID, "first", target);
    await expect(h.store.write(OTHER_ID, "second", target)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await h.store.read(target, "/")).toBe("first");
  });

  it("refuses to read a symlink", async () => {
    const h = await make();
    const link = join(h.outDir, "link.json");
    h.plantSymlink(link);
    await expect(h.store.read(link, "/")).rejects.toThrow("plan is not a regular file");
  });

  it("refuses to read an oversized file", async () => {
    const h = await make();
    const big = join(h.outDir, "big.json");
    h.plant(big, "x".repeat(MAX_PLAN_BYTES + 1));
    await expect(h.store.read(big, "/")).rejects.toThrow("plan file is too large");
  });

  it("still reads a file exactly at the size limit", async () => {
    const h = await make();
    const edge = join(h.outDir, "edge.json");
    h.plant(edge, "x".repeat(MAX_PLAN_BYTES));
    expect((await h.store.read(edge, "/")).length).toBe(MAX_PLAN_BYTES);
  });

  it("rejects reading a missing plan, by id and by path", async () => {
    const h = await make();
    await expect(h.store.read(ID, "/")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(h.store.read("nope.json", h.outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("FilePlanStore on disk", () => {
  it("creates plan files with mode 0600 in the plans directory", async () => {
    const { state } = await openSandboxState();
    const path = await new FilePlanStore(state).write(ID, "secret-free text");
    expect(path).toBe(join(state.plansDir, `${ID}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("secret-free text");
  });
});
