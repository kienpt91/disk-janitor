import { describe, expect, it } from "vitest";
import { normalizeRootSet, RootsError, rootViolation } from "../../src/domain/policy/roots.js";

const HOMES = ["/work/dev"];
const check = (abs: string, real = abs, homes: readonly string[] = HOMES, protectedHomes: readonly string[] = HOMES) => rootViolation(abs, real, homes, protectedHomes);

describe("rootViolation", () => {
  describe("acceptable roots", () => {
    it.each(["/work/dev/projects", "/work/dev/code/a", "/work/projects", "/data/repos", "/private/var/folders/ab/cd/T/dj-test", "/var/folders/x"])("accepts %s", (p) => {
      expect(check(p)).toBeNull();
    });

    it("accepts a root whose resolved path differs from the typed one when both are fine", () => {
      expect(check("/work/dev/link", "/data/repos")).toBeNull();
    });
  });

  describe("the file system root", () => {
    it("refuses '/'", () => {
      expect(check("/")).toBe("refusing '/' as a root");
    });

    it("refuses a path that resolves to '/'", () => {
      expect(check("/work/dev/link", "/")).toBe("refusing '/' as a root");
    });

    it("refuses a typed '/' even if it resolved elsewhere", () => {
      expect(check("/", "/data/repos")).toBe("refusing '/' as a root");
    });
  });

  describe("the home directory", () => {
    it("refuses the home itself", () => {
      expect(check("/work/dev")).toBe("refusing the home directory itself as a root; pass a subdirectory such as ~/projects");
    });

    it("refuses a symlink that resolves to the home", () => {
      expect(check("/work/shortcut", "/work/dev")).toMatch(/home directory itself/);
    });

    it("refuses any listed home, canonical or literal", () => {
      expect(check("/data/dev", "/data/dev", ["/work/dev", "/data/dev"])).toMatch(/home directory itself/);
    });

    it("refuses a parent of the home", () => {
      expect(check("/work")).toBe("refusing a root that contains the home directory");
    });

    it("refuses a grandparent of the home", () => {
      expect(check("/work", "/work", ["/work/a/b"], [])).toBe("refusing a root that contains the home directory");
    });

    it("allows a subdirectory of the home", () => {
      expect(check("/work/dev/projects")).toBeNull();
    });

    it("does not treat a sibling with a shared name prefix as the home or its parent", () => {
      expect(check("/work/dev2/projects")).toBeNull();
      expect(check("/work/dev2")).toBeNull();
    });
  });

  describe("system directories", () => {
    const exact = [
      "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libexec", "/media", "/mnt", "/nix", "/opt", "/proc", "/root", "/run",
      "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var", "/Applications", "/Library", "/System", "/Users", "/Volumes", "/cores", "/private",
      "/private/etc", "/private/tmp", "/private/var", "/private/var/db", "/private/var/folders",
    ];
    it.each(exact)("refuses %s itself", (p) => {
      expect(check(p)).toBe(`refusing system directory ${p} as a root`);
    });

    it("refuses when the typed path is a system directory even if it resolves elsewhere", () => {
      expect(check("/tmp", "/data/scratch")).toBe("refusing system directory /tmp as a root");
    });

    it("refuses a symlink that resolves to a system directory", () => {
      expect(check("/work/dev/etc-link", "/etc")).toBe("refusing system directory /etc as a root");
    });
  });

  describe("inside system trees", () => {
    const trees = [
      ["/usr/local/src", "/usr"],
      ["/etc/ssl/certs", "/etc"],
      ["/System/Library/x", "/System"],
      ["/Library/Developer", "/Library"],
      ["/Applications/Foo.app/Contents", "/Applications"],
      ["/opt/homebrew/Cellar", "/opt/homebrew"],
      ["/var/lib/docker", "/var/lib"],
      ["/var/log/app", "/var/log"],
      ["/private/etc/hosts.d", "/private/etc"],
      ["/private/var/db/x", "/private/var/db"],
      ["/nix/store/abc", "/nix"],
      ["/bin/sub", "/bin"],
      ["/proc/1", "/proc"],
    ];
    it.each(trees)("refuses %s (inside %s)", (p, tree) => {
      expect(check(p)).toBe(`refusing a root inside system location ${tree}`);
    });

    it("refuses a symlink that resolves into a system tree", () => {
      expect(check("/work/dev/p", "/usr/local/x")).toBe("refusing a root inside system location /usr");
    });

    it("allows /opt subdirectories other than homebrew", () => {
      expect(check("/opt/data/repos")).toBeNull();
    });
  });

  describe("protected locations", () => {
    it("refuses a root with a protected path component", () => {
      expect(check("/work/dev/projects/.ssh/x")).toBe('refusing a root in a protected location: path component ".ssh" is protected');
    });

    it("refuses a nested .git component", () => {
      expect(check("/data/repos/app/.git/modules")).toMatch(/^refusing a root in a protected location: path component "\.git"/);
    });

    it("refuses personal directories under the home", () => {
      expect(check("/work/dev/Documents/code")).toBe("refusing a root in a protected location: inside the protected location ~/documents");
      expect(check("/work/dev/Downloads")).toMatch(/~\/downloads/);
    });

    it("judges the resolved path, not the typed one", () => {
      expect(check("/work/dev/projects", "/work/dev/Desktop/p")).toMatch(/~\/desktop/);
    });

    it("refuses names that look like secrets", () => {
      expect(check("/data/repos/team-secrets")).toMatch(/looks like a secret/);
    });

    it("applies the user-home pattern even when the home is not among the protected homes", () => {
      expect(check("/Users/someone/Documents/x", "/Users/someone/Documents/x", ["/work/dev"], [])).toMatch(/~\/documents/);
    });
  });

  describe("ordering", () => {
    it("reports the file system root before anything else", () => {
      expect(check("/", "/", ["/"], ["/"])).toBe("refusing '/' as a root");
    });

    it("reports the home before system directories", () => {
      expect(check("/home/dev", "/home/dev", ["/home/dev"], [])).toMatch(/home directory itself/);
    });
  });
});

describe("normalizeRootSet", () => {
  it("returns an empty list for no roots", () => {
    expect(normalizeRootSet([])).toEqual([]);
  });

  it("sorts roots", () => {
    expect(normalizeRootSet(["/b", "/c", "/a"])).toEqual(["/a", "/b", "/c"]);
  });

  it("removes exact duplicates", () => {
    expect(normalizeRootSet(["/a", "/b", "/a", "/a"])).toEqual(["/a", "/b"]);
  });

  it("does not mutate its input", () => {
    const input = ["/b", "/a", "/b"];
    normalizeRootSet(input);
    expect(input).toEqual(["/b", "/a", "/b"]);
  });

  it("accepts siblings that share a name prefix", () => {
    expect(normalizeRootSet(["/work/app", "/work/app2", "/work/app-old"])).toEqual(["/work/app", "/work/app-old", "/work/app2"]);
  });

  it.each([
    [["/a", "/a/b"]],
    [["/a/b", "/a"]],
    [["/a/b/c", "/x", "/a"]],
    [["/a", "/a/b", "/a"]],
  ])("rejects nested roots %j in either order", (roots) => {
    expect(() => normalizeRootSet(roots)).toThrow(RootsError);
    expect(() => normalizeRootSet(roots)).toThrow("roots must not be nested inside each other");
  });

  it("RootsError has its own name", () => {
    expect(new RootsError("x").name).toBe("RootsError");
  });
});
