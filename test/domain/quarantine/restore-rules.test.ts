import { describe, expect, it } from "vitest";
import { restoreParent, restoreRefusal, type RestoreFacts } from "../../../src/domain/quarantine/restore-rules.js";
import type { ManifestEntry, ManifestScope } from "../../../src/domain/quarantine/manifest.js";
import { HOME, newManifest, ROOT } from "../../support/domain-fixtures.js";

const scope: ManifestScope = { roots: [ROOT], home: HOME, detectors: ["node-modules", "package-cache"] };

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  const base = newManifest(1).markQuarantined(1, 10).entry(1) as ManifestEntry;
  return { ...base, ...overrides };
}

const good = (e: ManifestEntry): RestoreFacts => ({
  item: { present: true, directory: true, symlink: false, dev: BigInt(e.dev), ino: BigInt(e.ino) },
  parent: "ok",
  original: "absent",
});

describe("restoreRefusal: the quarantined item may be put back", () => {
  it("returns null when every fact is good, for a quarantined and for a pending entry", () => {
    const q = entry();
    expect(restoreRefusal(scope, q, good(q))).toBeNull();
    const p = entry({ status: "pending" });
    expect(restoreRefusal(scope, p, good(p))).toBeNull();
  });

  it.each(["restored", "purged"] as const)("refuses an entry whose status is %s", (status) => {
    const e = entry({ status });
    expect(restoreRefusal(scope, e, good(e))).toBe(`status is ${status}`);
  });

  it("refuses when the stored item is missing", () => {
    const e = entry();
    expect(restoreRefusal(scope, e, { ...good(e), item: { present: false } })).toBe("quarantined item is missing");
  });

  it("refuses when the stored item is a symlink or not a directory", () => {
    const e = entry();
    const base = good(e).item as Extract<RestoreFacts["item"], { present: true }>;
    expect(restoreRefusal(scope, e, { ...good(e), item: { ...base, symlink: true } })).toBe("quarantined item is not a directory any more");
    expect(restoreRefusal(scope, e, { ...good(e), item: { ...base, directory: false } })).toBe("quarantined item is not a directory any more");
  });

  it("refuses when the inode or the device differs from the manifest", () => {
    const e = entry();
    const base = good(e).item as Extract<RestoreFacts["item"], { present: true }>;
    expect(restoreRefusal(scope, e, { ...good(e), item: { ...base, ino: base.ino + 1n } })).toBe("quarantined item changed (inode mismatch)");
    expect(restoreRefusal(scope, e, { ...good(e), item: { ...base, dev: base.dev + 1n } })).toBe("quarantined item changed (inode mismatch)");
  });

  it("refuses an original path outside the roots recorded in the manifest", () => {
    const e = entry({ originalPath: "/elsewhere/node_modules" });
    expect(restoreRefusal(scope, e, good(e))).toBe("original path is outside the roots recorded in the manifest");
  });

  it("accepts an original path that is a documented cache location when the package-cache detector was on", () => {
    const e = entry({ detector: "package-cache", originalPath: `${HOME}/.npm/_cacache` });
    expect(restoreRefusal(scope, e, good(e))).toBeNull();
    expect(restoreRefusal({ ...scope, detectors: ["node-modules"] }, e, good(e))).toBe("original path is outside the roots recorded in the manifest");
  });

  it("refuses a protected original path even when it lies inside a root", () => {
    const e = entry({ originalPath: `${ROOT}/p1/.git` });
    const reason = restoreRefusal(scope, e, good(e));
    expect(reason).not.toBeNull();
    expect(reason).not.toBe("original path is outside the roots recorded in the manifest");
  });

  it("refuses when the parent directory is missing, or a parent component is a link", () => {
    const e = entry();
    expect(restoreRefusal(scope, e, { ...good(e), parent: "missing" })).toBe("parent directory does not exist");
    expect(restoreRefusal(scope, e, { ...good(e), parent: "link" })).toBe("a parent path component is a symlink or not a directory");
  });

  it("refuses to overwrite, and when the original path cannot be inspected", () => {
    const e = entry();
    expect(restoreRefusal(scope, e, { ...good(e), original: "present" })).toBe("something already exists at the original path; refusing to overwrite");
    expect(restoreRefusal(scope, e, { ...good(e), original: "uninspectable" })).toBe("cannot inspect the original path");
  });

  it("reports the first failing rule when several fail (fixed order)", () => {
    const e = entry({ originalPath: "/elsewhere/x", status: "restored" });
    expect(restoreRefusal(scope, e, { item: { present: false }, parent: "missing", original: "present" })).toBe("status is restored");
    const q = entry({ originalPath: "/elsewhere/x" });
    expect(restoreRefusal(scope, q, { item: { present: false }, parent: "missing", original: "present" })).toBe("quarantined item is missing");
    expect(restoreRefusal(scope, q, { ...good(q), parent: "missing", original: "present" })).toBe("original path is outside the roots recorded in the manifest");
    const inside = entry();
    expect(restoreRefusal(scope, inside, { ...good(inside), parent: "link", original: "present" })).toBe("a parent path component is a symlink or not a directory");
  });

  it("restoreParent is the directory above the original path", () => {
    expect(restoreParent({ originalPath: "/a/b/c" })).toBe("/a/b");
    expect(restoreParent({ originalPath: "/a" })).toBe("/");
  });
});
