import { describe, expect, it } from "vitest";
import { commandKey, parseRepositoryConfigKeys, untrustedConfigReason } from "../../../src/domain/discovery/repo-config.js";
import { repositoryRefusal } from "../../../src/domain/discovery/eligibility.js";

const rec = (scope: string, key: string, value = "v") => `${scope}\0${key}\n${value}\0`;

describe("parseRepositoryConfigKeys", () => {
  it("reads the names of the repository's own settings", () => {
    expect(parseRepositoryConfigKeys(rec("local", "core.bare", "false") + rec("worktree", "user.name", "a\nb"))).toEqual(["core.bare", "user.name"]);
  });
  it("leaves out settings of every other scope", () => {
    const out = rec("unknown", "credential.helper", "osxkeychain") + rec("system", "core.pager") + rec("global", "core.hooksPath") + rec("command", "core.fsmonitor", "false") + rec("local", "core.bare");
    expect(parseRepositoryConfigKeys(out)).toEqual(["core.bare"]);
  });
  it("accepts valueless records, empty output and odd trailing separators", () => {
    expect(parseRepositoryConfigKeys("local\0core.logallrefupdates\0")).toEqual(["core.logallrefupdates"]);
    expect(parseRepositoryConfigKeys("")).toEqual([]);
    expect(parseRepositoryConfigKeys("\0\0")).toEqual([]);
    expect(parseRepositoryConfigKeys("local")).toEqual([]);
  });
  it("does not take a name from a value that contains a newline and something key-like", () => {
    expect(parseRepositoryConfigKeys(rec("local", "user.name", "x\nfilter.evil.clean\nz"))).toEqual(["user.name"]);
  });
});

describe("commandKey", () => {
  it.each([
    "filter.evil.clean",
    "filter.evil.smudge",
    "filter.evil.process",
    "filter.evil.required",
    "core.fsmonitor",
    "core.hooksPath",
    "core.hookspath",
    "core.sshCommand",
    "core.pager",
    "core.editor",
    "core.askPass",
    "core.gitProxy",
    "diff.word.textconv",
    "diff.word.command",
    "diff.some.sub.section.textconv",
    "merge.custom.driver",
    "include.path",
    "includeIf.gitdir:/x/.path",
    "includeif.onbranch:main.path",
    "credential.helper",
    "credential.https://example.com.helper",
  ])("refuses %s", (key) => {
    expect(commandKey(["core.bare", key, "user.name"])).toBe(key);
  });

  it.each([
    "core.bare",
    "core.repositoryformatversion",
    "core.filemode",
    "core.autocrlf",
    "core.worktree",
    "core.excludesFile",
    "remote.origin.url",
    "branch.main.remote",
    "user.name",
    "diff.algorithm",
    "diff.word.binary",
    "merge.ff",
    "merge.custom.name",
    "credential.username",
    "filterx.name",
    "mycore.fsmonitor",
    "core.pagerx",
    "extensions.worktreeconfig",
  ])("accepts %s", (key) => {
    expect(commandKey([key])).toBeNull();
  });

  it("returns the first offending key in listed order", () => {
    expect(commandKey(["core.pager", "filter.a.clean"])).toBe("core.pager");
  });
  it("is null for an empty configuration", () => {
    expect(commandKey([])).toBeNull();
  });
});

describe("untrusted repository refusal", () => {
  it("names the key and escapes anything hostile in it", () => {
    expect(untrustedConfigReason("filter.evil.clean")).toBe("inside a git repository whose config defines commands (filter.evil.clean)");
    const hostile = untrustedConfigReason("filter.\u001b[31m.clean\nforged line");
    expect(hostile).not.toContain("\u001b");
    expect(hostile).not.toContain("\n");
  });
  it("caps the length of the key", () => {
    expect(untrustedConfigReason("filter." + "a".repeat(1000) + ".clean").length).toBeLessThan(200);
  });
  it("makes repositoryRefusal refuse before looking at the repository root", () => {
    expect(repositoryRefusal({ state: "untrusted", key: "core.pager" }, "/r")).toBe("inside a git repository whose config defines commands (core.pager)");
  });
});
