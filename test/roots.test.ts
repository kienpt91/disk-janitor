import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { FsApi } from "../src/fsapi.js";
import { RootsError, validateRoots } from "../src/roots.js";
import { makeSandbox, testDeps, writeText, type Sandbox } from "./helpers.js";

const fs = testDeps().fs;

function opts(sb: Sandbox, extra: { cwd?: string; homes?: string[] } = {}) {
  return { homes: extra.homes ?? [sb.home], fs, cwd: extra.cwd };
}

/** A file system view where every path "exists" as a directory and realpath is the identity. */
function pretendFs(sb: Sandbox): FsApi {
  return { ...fs, realpath: async (p) => p, lstat: () => fs.lstat(sb.projects) };
}

describe("validateRoots: accepted roots", () => {
  it("returns the canonical path of a valid root", async () => {
    const sb = makeSandbox();
    expect(await validateRoots([sb.projects], opts(sb))).toEqual([sb.projects]);
  });

  it("accepts several sibling roots and returns them sorted", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "b"));
    mkdirSync(join(sb.home, "a"));
    expect(await validateRoots([join(sb.home, "b"), join(sb.home, "a")], opts(sb))).toEqual([join(sb.home, "a"), join(sb.home, "b")]);
  });

  it("collapses duplicates", async () => {
    const sb = makeSandbox();
    expect(await validateRoots([sb.projects, sb.projects], opts(sb))).toEqual([sb.projects]);
  });

  it("collapses a symlink and its target to one root", async () => {
    const sb = makeSandbox();
    symlinkSync(sb.projects, join(sb.home, "alias"));
    expect(await validateRoots([sb.projects, join(sb.home, "alias")], opts(sb))).toEqual([sb.projects]);
  });

  it("resolves a symlinked root to its realpath", async () => {
    const sb = makeSandbox();
    symlinkSync(sb.projects, join(sb.base, "link"));
    expect(await validateRoots([join(sb.base, "link")], opts(sb))).toEqual([sb.projects]);
  });

  it("resolves a relative root against cwd", async () => {
    const sb = makeSandbox();
    expect(await validateRoots(["projects"], opts(sb, { cwd: sb.home }))).toEqual([sb.projects]);
    expect(await validateRoots(["./projects/../projects"], opts(sb, { cwd: sb.home }))).toEqual([sb.projects]);
  });
});

describe("validateRoots: refused roots", () => {
  it("refuses an empty root list", async () => {
    const sb = makeSandbox();
    await expect(validateRoots([], opts(sb))).rejects.toThrow("no roots configured");
    await expect(validateRoots([], opts(sb))).rejects.toBeInstanceOf(RootsError);
  });

  it("refuses '/'", async () => {
    const sb = makeSandbox();
    await expect(validateRoots(["/"], opts(sb))).rejects.toThrow("refusing '/' as a root");
  });

  it("refuses the home directory itself", async () => {
    const sb = makeSandbox();
    await expect(validateRoots([sb.home], opts(sb))).rejects.toThrow("refusing the home directory itself");
  });

  it("refuses a symlink that points at the home directory", async () => {
    const sb = makeSandbox();
    symlinkSync(sb.home, join(sb.base, "homelink"));
    await expect(validateRoots([join(sb.base, "homelink")], opts(sb))).rejects.toThrow("refusing the home directory itself");
  });

  it("refuses a parent of the home directory", async () => {
    const sb = makeSandbox();
    await expect(validateRoots([sb.base], opts(sb))).rejects.toThrow("contains the home directory");
  });

  it.each(["/etc", "/usr", "/var"])("refuses system directory %s", async (dir) => {
    const sb = makeSandbox();
    await expect(validateRoots([dir], opts(sb))).rejects.toThrow(`system directory ${dir}`);
  });

  it("refuses a root inside a system tree", async () => {
    const sb = makeSandbox();
    await expect(validateRoots(["/usr/share"], opts(sb))).rejects.toThrow("inside system location /usr");
  });

  it.each([
    ["/Users", "system directory /Users"],
    ["/private/etc", "system directory /private/etc"],
    ["/private/var/folders", "system directory /private/var/folders"],
    ["/System", "system directory /System"],
    ["/Library", "system directory /Library"],
    ["/Applications", "system directory /Applications"],
    ["/Volumes", "system directory /Volumes"],
    ["/home", "system directory /home"],
    ["/Library/Foo", "inside system location /Library"],
    ["/opt/homebrew/Cellar", "inside system location /opt/homebrew"],
    ["/private/var/db/x", "inside system location /private/var/db"],
    ["/System/Volumes/Data", "inside system location /System"],
    ["/var/lib/docker", "inside system location /var/lib"],
  ])("refuses %s (macOS and Linux system paths)", async (dir, msg) => {
    const sb = makeSandbox();
    await expect(validateRoots([dir], { homes: [sb.home], fs: pretendFs(sb) })).rejects.toThrow(msg);
  });

  it("refuses the parent of /Users/<name> style homes", async () => {
    const sb = makeSandbox();
    await expect(validateRoots(["/Users/alice"], { homes: ["/Users/alice"], fs: pretendFs(sb) })).rejects.toThrow("home directory itself");
    await expect(validateRoots(["/Users"], { homes: ["/Users/alice"], fs: pretendFs(sb) })).rejects.toThrow("contains the home directory");
  });

  it("refuses /tmp, which contains the sandbox home", async () => {
    const sb = makeSandbox();
    await expect(validateRoots(["/tmp"], opts(sb))).rejects.toThrow("contains the home directory");
    await expect(validateRoots(["/tmp"], { homes: ["/nonexistent-home/alice"], fs })).rejects.toThrow("system directory /tmp");
  });

  it("refuses a nonexistent root", async () => {
    const sb = makeSandbox();
    await expect(validateRoots([join(sb.home, "nope")], opts(sb))).rejects.toThrow(`root does not exist: ${JSON.stringify(join(sb.home, "nope"))}`);
  });

  it("refuses a file instead of a directory", async () => {
    const sb = makeSandbox();
    const file = join(sb.home, "file.txt");
    writeText(file, "x");
    await expect(validateRoots([file], opts(sb))).rejects.toThrow(`root is not a directory: ${JSON.stringify(file)}`);
  });

  it("refuses a root inside ~/Documents as protected", async () => {
    const sb = makeSandbox();
    const dir = join(sb.home, "Documents", "code");
    mkdirSync(dir, { recursive: true });
    await expect(validateRoots([dir], opts(sb))).rejects.toThrow("protected location");
  });

  it("refuses roots in other protected places such as Dropbox and .ssh", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "Dropbox", "code"), { recursive: true });
    mkdirSync(join(sb.home, ".ssh"), { recursive: true });
    await expect(validateRoots([join(sb.home, "Dropbox", "code")], opts(sb))).rejects.toThrow('"dropbox"');
    await expect(validateRoots([join(sb.home, ".ssh")], opts(sb))).rejects.toThrow('".ssh"');
  });

  it("refuses a symlink into a protected location (checked on the realpath)", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "Documents", "code"), { recursive: true });
    symlinkSync(join(sb.home, "Documents", "code"), join(sb.projects, "sneaky"));
    await expect(validateRoots([join(sb.projects, "sneaky")], opts(sb))).rejects.toThrow("protected location");
  });

  it("refuses nested roots", async () => {
    const sb = makeSandbox();
    const inner = join(sb.projects, "inner");
    mkdirSync(inner);
    await expect(validateRoots([sb.projects, inner], opts(sb))).rejects.toThrow("roots must not be nested");
    await expect(validateRoots([inner, sb.projects], opts(sb))).rejects.toThrow("roots must not be nested");
  });

  it("does not treat prefix-sharing sibling roots as nested", async () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.home, "app"));
    mkdirSync(join(sb.home, "app2"));
    expect(await validateRoots([join(sb.home, "app"), join(sb.home, "app2")], opts(sb))).toHaveLength(2);
  });

  it("refuses empty strings and NUL bytes", async () => {
    const sb = makeSandbox();
    await expect(validateRoots([""], opts(sb))).rejects.toThrow("empty or contains a NUL");
    await expect(validateRoots([sb.projects + "\0x"], opts(sb))).rejects.toThrow("empty or contains a NUL");
  });

  it("checks every configured home, including a symlinked home's realpath", async () => {
    const sb = makeSandbox();
    const alias = join(sb.base, "homealias");
    symlinkSync(sb.home, alias);
    await expect(validateRoots([sb.home], { homes: [alias], fs })).rejects.toThrow("home directory itself");
    await expect(validateRoots([sb.base], { homes: [alias], fs })).rejects.toThrow("contains the home directory");
  });

  it("a home that does not exist is ignored but still checked textually", async () => {
    const sb = makeSandbox();
    const missing = join(sb.base, "ghost-home");
    expect(await validateRoots([sb.projects], { homes: [missing], fs })).toEqual([sb.projects]);
  });
});
