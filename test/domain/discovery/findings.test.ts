import { describe, expect, it } from "vitest";
import { Findings, MAX_SKIPPED } from "../../../src/domain/discovery/findings.js";
import { newFsFinding, type FsFinding } from "../../../src/domain/model/candidate.js";

function fsf(path: string, size: number, detector: FsFinding["detector"] = "node-modules"): FsFinding {
  return newFsFinding({ detector, path, dev: 1n, ino: 1n, size, entries: 1, mtimeMs: 0, newestMtimeMs: 0, ageDays: 40, reason: "r", regenerate: "g" });
}

describe("Findings", () => {
  it("lists candidates largest first, ties by path", () => {
    const f = new Findings();
    f.accept(fsf("/r/b", 10));
    f.accept(fsf("/r/a", 10));
    f.accept(fsf("/r/c", 99));
    expect(f.close(10).fs.map((c) => c.path)).toEqual(["/r/c", "/r/a", "/r/b"]);
  });

  it("drops a candidate inside another and records why", () => {
    const f = new Findings();
    f.accept(fsf("/r/app/dist", 100, "build-output"));
    f.accept(fsf("/r/app/dist/cache", 5, "build-output"));
    f.accept(fsf("/r/app/dist2", 7, "build-output"));
    const s = f.close(10);
    expect(s.fs.map((c) => c.path)).toEqual(["/r/app/dist", "/r/app/dist2"]);
    expect(s.skipped).toEqual([{ detector: "build-output", path: "/r/app/dist/cache", reason: "inside another candidate" }]);
    expect(s.skippedCount).toBe(1);
  });

  it("keeps the outermost regardless of acceptance order", () => {
    const f = new Findings();
    f.accept(fsf("/r/a/b/c", 1));
    f.accept(fsf("/r/a", 2));
    expect(f.close(10).fs.map((c) => c.path)).toEqual(["/r/a"]);
  });

  it("does not treat a sibling with a common name prefix as nested", () => {
    const f = new Findings();
    f.accept(fsf("/r/node", 1));
    f.accept(fsf("/r/node_modules", 2));
    expect(f.close(10).fs).toHaveLength(2);
  });

  it("caps the listed candidates to the largest and warns", () => {
    const f = new Findings();
    for (let i = 0; i < 5; i++) f.accept(fsf(`/r/p${i}`, i + 1));
    const s = f.close(2);
    expect(s.fs.map((c) => c.size)).toEqual([5, 4]);
    expect(s.warnings).toEqual(["more than 2 candidates found; only the largest are listed"]);
  });

  it("does not warn at exactly the cap", () => {
    const f = new Findings();
    f.accept(fsf("/r/a", 1));
    f.accept(fsf("/r/b", 2));
    expect(f.close(2).warnings).toEqual([]);
  });

  it("bounds the skipped list but counts every skip", () => {
    const f = new Findings();
    for (let i = 0; i < MAX_SKIPPED + 25; i++) f.skip("build-output", `/r/p${i}`, "x");
    const s = f.close(1);
    expect(s.skipped).toHaveLength(MAX_SKIPPED);
    expect(s.skippedCount).toBe(MAX_SKIPPED + 25);
    expect(s.skipped[0]?.path).toBe("/r/p0");
  });

  it("collects reports and warnings in order", () => {
    const f = new Findings();
    f.report({ detector: "docker", title: "a", detail: "1" });
    f.report({ detector: "git-worktrees", title: "b", detail: "2", path: "/x" });
    f.warn("w1");
    f.warn("w2");
    const s = f.close(1);
    expect(s.reports.map((r) => r.title)).toEqual(["a", "b"]);
    expect(s.warnings).toEqual(["w1", "w2"]);
  });
});
