import { describe, expect, it } from "vitest";
import {
  MAX_PROBLEMS,
  PROBLEM,
  quickRecheckProblem,
  Revalidation,
  swappedBeforeRename,
  type ChainFact,
  type ObservedNode,
  type ObservedTree,
  type RevalidationContext,
} from "../../../src/domain/apply/revalidation.js";
import type { FsCandidate } from "../../../src/domain/model/types.js";
import { candidate, HOME, ROOT } from "../../support/domain-fixtures.js";

const PLAN_AT = 100_000;
const context: RevalidationContext = {
  config: { roots: [ROOT], home: HOME, detectors: ["node-modules", "build-output", "package-cache"] },
  planCreatedAt: PLAN_AT,
  itemsDevice: 100n,
};

const nodeFor = (c: FsCandidate, over: Partial<ObservedNode> = {}): ObservedNode => ({
  dev: BigInt(c.dev),
  ino: BigInt(c.ino),
  isDirectory: true,
  isSymbolicLink: false,
  mtimeMs: c.mtimeMs,
  ...over,
});
const rootNode = (c: FsCandidate, over: Partial<ObservedNode> = {}): ObservedNode => nodeFor(c, { ino: 7n, mtimeMs: 0, ...over });
const treeFor = (c: FsCandidate, over: Partial<Extract<ObservedTree, { ok: true }>> = {}): ObservedTree => ({ ok: true, size: c.size, entries: c.entries, newestMtimeMs: c.newestMtimeMs, ...over });
const clean: ChainFact = { kind: "clean" };

/** Runs the whole pipeline the way the application layer does and returns the problems. */
function runAll(
  c: FsCandidate,
  opts: { chain?: ChainFact; node?: ObservedNode | null; base?: ObservedNode | null; tree?: ObservedTree; open?: string | null; ctx?: RevalidationContext; others?: FsCandidate[] } = {},
): readonly string[] {
  const run = new Revalidation(opts.ctx ?? context, [c, ...(opts.others ?? [])]);
  const check = run.candidate(0);
  check.overlap();
  if (check.location() && check.chain(opts.chain ?? clean) && check.node(opts.node === undefined ? nodeFor(c) : opts.node, opts.base === undefined ? rootNode(c) : opts.base) && check.tree(opts.tree ?? treeFor(c))) {
    check.open(opts.open ?? null);
  }
  return run.problems;
}

describe("Revalidation: the all-good path", () => {
  it("a candidate exactly as planned yields no problems", () => {
    const c = candidate(1);
    expect(runAll(c)).toEqual([]);
    const run = new Revalidation(context, [c]);
    expect(run.ok).toBe(true);
  });

  it("mtime equal to the plan time is acceptable (only newer is a problem)", () => {
    const c = candidate(1, { mtimeMs: PLAN_AT, newestMtimeMs: PLAN_AT });
    expect(runAll(c)).toEqual([]);
  });
});

describe("Revalidation: each problem string", () => {
  const c = candidate(1);
  const tag = (why: string) => [`${c.id} ${c.path}: ${why}`];

  it("overlap: a candidate that contains another candidate", () => {
    const inner = candidate(2, { path: `${c.path}/inner` });
    expect(runAll(c, { others: [inner] })).toEqual(tag(PROBLEM.overlap));
    expect(PROBLEM.overlap).toBe("contains another candidate");
  });

  it("overlap does not stop the other stages", () => {
    const inner = candidate(2, { path: `${c.path}/inner` });
    expect(runAll(c, { others: [inner], node: nodeFor(c, { isSymbolicLink: true }) })).toEqual([...tag("contains another candidate"), ...tag("is now a symlink")]);
  });

  it("two identical paths count as overlapping each other", () => {
    const twin = candidate(2, { path: c.path });
    const run = new Revalidation(context, [c, twin]);
    run.candidate(0).overlap();
    run.candidate(1).overlap();
    expect(run.problems).toEqual([`${c.id} ${c.path}: contains another candidate`, `${twin.id} ${twin.path}: contains another candidate`]);
  });

  it("siblings do not overlap", () => {
    const sib = candidate(1, { id: "c0009", path: `${c.path}-other` });
    expect(runAll(c, { others: [sib] })).toEqual([]);
  });

  it("path is not canonical", () => {
    const bad = candidate(1, { path: `${ROOT}/p1/../p1/node_modules` });
    expect(runAll(bad)).toEqual([`${bad.id} ${bad.path}: path is not canonical`]);
  });

  it("outside the configured roots", () => {
    const out = candidate(1, { path: "/var/tmp/node_modules" });
    expect(runAll(out)).toEqual([`${out.id} ${out.path}: outside the configured roots`]);
  });

  it("a protected path is refused with the protection's own reason", () => {
    const prot = candidate(1, { path: `${ROOT}/p1/.git` });
    const problems = runAll(prot);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${prot.id} ${prot.path}: .+`));
    expect(problems[0]).not.toContain("outside the configured roots");
  });

  it("a package-cache candidate is allowed at a documented cache location below home", () => {
    const cache = candidate(1, { detector: "package-cache", path: `${HOME}/.npm/_cacache` });
    expect(runAll(cache)).toEqual([]);
  });

  it("cannot inspect the path (with the error code)", () => {
    expect(runAll(c, { chain: { kind: "unreadable", code: "EACCES" } })).toEqual(tag("cannot inspect the path (EACCES)"));
  });

  it("a symlink or non-directory appeared in the path", () => {
    expect(runAll(c, { chain: { kind: "link" } })).toEqual(tag("a symlink or non-directory appeared in the path"));
  });

  it("path or its root disappeared (either stat missing)", () => {
    expect(runAll(c, { node: null })).toEqual(tag("path or its root disappeared"));
    expect(runAll(c, { base: null })).toEqual(tag("path or its root disappeared"));
  });

  it("its root is not a real directory any more", () => {
    expect(runAll(c, { base: rootNode(c, { isDirectory: false }) })).toEqual(tag("its root is not a real directory any more"));
    expect(runAll(c, { base: rootNode(c, { isSymbolicLink: true }) })).toEqual(tag("its root is not a real directory any more"));
  });

  it("is now a symlink", () => {
    expect(runAll(c, { node: nodeFor(c, { isSymbolicLink: true }) })).toEqual(tag("is now a symlink"));
  });

  it("is no longer a directory", () => {
    expect(runAll(c, { node: nodeFor(c, { isDirectory: false }) })).toEqual(tag("is no longer a directory"));
  });

  it("device or inode changed since the plan was made", () => {
    expect(runAll(c, { node: nodeFor(c, { ino: BigInt(c.ino) + 1n }) })).toEqual(tag("device or inode changed since the plan was made"));
    expect(runAll(c, { node: nodeFor(c, { dev: 5n }), base: rootNode(c, { dev: 5n }) })).toEqual(tag("device or inode changed since the plan was made"));
  });

  it("is on a different file system than its root", () => {
    expect(runAll(c, { base: rootNode(c, { dev: 99n }) })).toEqual(tag("is on a different file system than its root"));
  });

  it("is on a different file system than the quarantine", () => {
    expect(runAll(c, { ctx: { ...context, itemsDevice: 7n } })).toEqual(
      tag("is on a different file system than the quarantine; rename cannot cross devices and copying is never done"),
    );
  });

  it("directory was modified after the plan was made (mtime changed, or newer than the plan)", () => {
    expect(runAll(c, { node: nodeFor(c, { mtimeMs: c.mtimeMs + 1 }) })).toEqual(tag("directory was modified after the plan was made"));
    const late = candidate(1, { mtimeMs: PLAN_AT + 1 });
    expect(runAll(late)).toEqual([`${late.id} ${late.path}: directory was modified after the plan was made`]);
  });

  it("the tree walk's own refusal is reported verbatim", () => {
    expect(runAll(c, { tree: { ok: false, reason: "crosses a file system boundary" } })).toEqual(tag("crosses a file system boundary"));
  });

  it("contents changed since the plan was made (size, entries or newest mtime)", () => {
    expect(runAll(c, { tree: treeFor(c, { size: c.size + 1 }) })).toEqual(tag("contents changed since the plan was made"));
    expect(runAll(c, { tree: treeFor(c, { entries: c.entries + 1 }) })).toEqual(tag("contents changed since the plan was made"));
    expect(runAll(c, { tree: treeFor(c, { newestMtimeMs: c.newestMtimeMs - 1 }) })).toEqual(tag("contents changed since the plan was made"));
  });

  it("contents are newer than the plan", () => {
    const newer = candidate(1, { newestMtimeMs: PLAN_AT + 5 });
    expect(runAll(newer)).toEqual([`${newer.id} ${newer.path}: contents are newer than the plan`]);
  });

  it("a process has files open inside it", () => {
    expect(runAll(c, { open: `${c.path}/a.js` })).toEqual(tag("a process has files open inside it"));
  });
});

describe("Revalidation: staging and collection", () => {
  it("a failing stage reports false so the caller skips the rest; later stages are the caller's choice", () => {
    const c = candidate(1, { path: "/nowhere/x" });
    const run = new Revalidation(context, [c]);
    const check = run.candidate(0);
    expect(check.location()).toBe(false);
    expect(run.ok).toBe(false);
    expect(() => check.baseDir).toThrow(/location\(\) must succeed/);
  });

  it("baseDir is the root the candidate lives under", () => {
    const run = new Revalidation(context, [candidate(1)]);
    const check = run.candidate(0);
    expect(check.location()).toBe(true);
    expect(check.baseDir).toBe(ROOT);
  });

  it("the cache base directory is home", () => {
    const run = new Revalidation(context, [candidate(1, { detector: "package-cache", path: `${HOME}/.npm/_cacache` })]);
    const check = run.candidate(0);
    expect(check.location()).toBe(true);
    expect(check.baseDir).toBe(HOME);
  });

  it("collects the problems of every candidate in plan order", () => {
    const a = candidate(1);
    const b = candidate(2);
    const run = new Revalidation(context, [a, b]);
    run.candidate(0).chain({ kind: "link" });
    run.candidate(1).open("/x");
    expect(run.problems).toEqual([`${a.id} ${a.path}: a symlink or non-directory appeared in the path`, `${b.id} ${b.path}: a process has files open inside it`]);
  });

  it("caps the problem list at MAX_PROBLEMS", () => {
    const list = Array.from({ length: MAX_PROBLEMS + 20 }, (_, i) => candidate(i + 1));
    const run = new Revalidation(context, list);
    for (let i = 0; i < list.length; i++) run.candidate(i).open("/open");
    expect(run.problems).toHaveLength(MAX_PROBLEMS);
    expect(run.problems[0]).toContain(list[0]?.id);
  });

  it("rejects a position outside the plan", () => {
    expect(() => new Revalidation(context, []).candidate(0)).toThrow(RangeError);
  });
});

describe("quickRecheckProblem (right before each rename)", () => {
  const c = candidate(1);
  it("no problem for the planned directory", () => {
    expect(quickRecheckProblem(c, clean, nodeFor(c))).toBeNull();
  });
  it("an unreadable chain or a vanished path is 'path disappeared'", () => {
    expect(quickRecheckProblem(c, { kind: "unreadable", code: "EIO" }, nodeFor(c))).toBe("path disappeared");
    expect(quickRecheckProblem(c, clean, null)).toBe("path disappeared");
  });
  it("a link in the chain wins even when the node could not be read", () => {
    expect(quickRecheckProblem(c, { kind: "link" }, null)).toBe("a symlink or non-directory appeared in the path");
  });
  it("a symlink or a non-directory is 'no longer a real directory'", () => {
    expect(quickRecheckProblem(c, clean, nodeFor(c, { isSymbolicLink: true }))).toBe("is no longer a real directory");
    expect(quickRecheckProblem(c, clean, nodeFor(c, { isDirectory: false }))).toBe("is no longer a real directory");
  });
  it("a different inode or device is 'device or inode changed'", () => {
    expect(quickRecheckProblem(c, clean, nodeFor(c, { ino: 1n }))).toBe("device or inode changed");
    expect(quickRecheckProblem(c, clean, nodeFor(c, { dev: 1n }))).toBe("device or inode changed");
  });
});

describe("swappedBeforeRename (what landed in quarantine)", () => {
  const c = candidate(1);
  it("is false for the planned directory", () => {
    expect(swappedBeforeRename(c, nodeFor(c))).toBe(false);
  });
  it("is true when nothing landed, a symlink landed, a file landed, or another inode landed", () => {
    expect(swappedBeforeRename(c, null)).toBe(true);
    expect(swappedBeforeRename(c, nodeFor(c, { isSymbolicLink: true }))).toBe(true);
    expect(swappedBeforeRename(c, nodeFor(c, { isDirectory: false }))).toBe(true);
    expect(swappedBeforeRename(c, nodeFor(c, { ino: 5n }))).toBe(true);
    expect(swappedBeforeRename(c, nodeFor(c, { dev: 5n }))).toBe(true);
  });
});
