import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalStore } from "../../src/application/ports/planning.js";
import { FileApprovalStore } from "../../src/infrastructure/state/approval-store.js";
import { MemoryApprovalStore } from "../support/fakes/memory-stores.js";
import { openSandboxState } from "../support/state.js";

interface Harness {
  store: ApprovalStore;
  /** What a directory listing of the store would show. */
  names(): string[];
}

async function memory(): Promise<Harness> {
  const store = new MemoryApprovalStore();
  return { store, names: () => store.names() };
}

async function file(): Promise<Harness> {
  const { state } = await openSandboxState();
  return { store: new FileApprovalStore(state), names: () => readdirSync(state.approvalsDir).sort() };
}

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

describe.each([
  ["memory", memory],
  ["file", file],
])("ApprovalStore contract: %s", (_name, make) => {
  it("reads null for a digest that was never written", async () => {
    const h = await make();
    expect(await h.store.read(D1)).toBeNull();
  });

  it("reads back exactly what was written", async () => {
    const h = await make();
    await h.store.write(D1, '{"x":1}\n');
    expect(await h.store.read(D1)).toBe('{"x":1}\n');
  });

  it("keeps approvals for different digests apart", async () => {
    const h = await make();
    await h.store.write(D1, "one");
    await h.store.write(D2, "two");
    expect(await h.store.read(D1)).toBe("one");
    expect(await h.store.read(D2)).toBe("two");
  });

  it("stores one file per digest, named after it, with no leftovers", async () => {
    const h = await make();
    await h.store.write(D1, "one");
    await h.store.write(D2, "two");
    expect(h.names()).toEqual([`${D1}.json`, `${D2}.json`]);
  });

  it("overwrite replaces the content and leaves a single file", async () => {
    const h = await make();
    await h.store.write(D1, "old");
    await h.store.write(D1, "new content that is longer");
    expect(await h.store.read(D1)).toBe("new content that is longer");
    await h.store.write(D1, "s");
    expect(await h.store.read(D1)).toBe("s");
    expect(h.names()).toEqual([`${D1}.json`]);
  });

  it("remove deletes the approval and only that one", async () => {
    const h = await make();
    await h.store.write(D1, "one");
    await h.store.write(D2, "two");
    await h.store.remove(D1);
    expect(await h.store.read(D1)).toBeNull();
    expect(await h.store.read(D2)).toBe("two");
    expect(h.names()).toEqual([`${D2}.json`]);
  });

  it("remove of a missing approval rejects with ENOENT", async () => {
    const h = await make();
    await expect(h.store.remove(D1)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an approval can be written again after it was removed", async () => {
    const h = await make();
    await h.store.write(D1, "one");
    await h.store.remove(D1);
    await h.store.write(D1, "again");
    expect(await h.store.read(D1)).toBe("again");
  });

  it.each(["", "abc", "../escape", `${"a".repeat(63)}/`, "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(62)}..`, `${D1}\n`])(
    "rejects the invalid digest %j on every operation",
    async (digest) => {
      const h = await make();
      await expect(h.store.write(digest, "x")).rejects.toThrow("invalid plan digest");
      await expect(h.store.read(digest)).rejects.toThrow("invalid plan digest");
      await expect(h.store.remove(digest)).rejects.toThrow("invalid plan digest");
      expect(h.names()).toEqual([]);
    },
  );
});

describe("FileApprovalStore on disk", () => {
  it("creates approval files with mode 0600 in the approvals directory", async () => {
    const { state } = await openSandboxState();
    await new FileApprovalStore(state).write(D1, "x");
    expect(statSync(join(state.approvalsDir, `${D1}.json`)).mode & 0o777).toBe(0o600);
  });
});
