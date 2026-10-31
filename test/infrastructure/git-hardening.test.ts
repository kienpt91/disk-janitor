import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../../src/composition/discovery.js";
import { nodeFs } from "../../src/infrastructure/fs/node-fs.js";
import { createGit } from "../../src/infrastructure/process/git.js";
import { ageTree, git, gitInit, makeConfig, makeProject, makeSandbox, testDeps, writeBytes, writeText, type Sandbox } from "../support/helpers.js";
import { baseArgs, cli } from "../support/helpers-cli.js";

/**
 * A repository whose own configuration tries to run a program during `git status`: a clean filter
 * attached to every path by .gitattributes. The program is configured only after the files were
 * committed (so building the fixture does not run it) and a tracked file is made stat-dirty (same
 * content, new mtime), which is what forces git to re-hash it through the filter.
 */
function filterTrap(dir: string, marker: string): void {
  writeText(join(dir, ".gitattributes"), "* filter=evil\n");
  gitInit(dir, "node_modules\ndist\n");
  git(dir, "config", "filter.evil.clean", `touch '${marker}'; cat`);
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, "package.json"), later, later);
}

function trappedProject(sb: Sandbox, name: string, marker: string): string {
  const dir = join(sb.projects, name);
  makeProject(dir, { ageDays: 60 });
  writeBytes(join(dir, "dist", "bundle.js"), 4096);
  ageTree(dir, 60);
  filterTrap(dir, marker);
  return dir;
}

describe("git in an untrusted repository", () => {
  it("worktreeClean never runs a clean filter configured by the repository", async () => {
    const sb = makeSandbox();
    const marker = join(sb.base, "pwned-status");
    const dir = trappedProject(sb, "evil", marker);
    expect(await createGit(testDeps().run, nodeFs).worktreeClean(dir)).toBe("error");
    expect(existsSync(marker)).toBe(false);
  });

  it("a scan never runs the filter, and says why the project was skipped", async () => {
    const sb = makeSandbox();
    const marker = join(sb.base, "pwned-scan");
    const dir = trappedProject(sb, "evil", marker);
    const deps = testDeps();
    const result = await scan(await makeConfig(sb, {}, deps), deps);
    expect(existsSync(marker)).toBe(false);
    expect(result.fs).toEqual([]);
    const reason = "inside a git repository whose config defines commands (filter.evil.clean)";
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { detector: "node-modules", path: join(dir, "node_modules"), reason },
        { detector: "build-output", path: join(dir, "dist"), reason },
      ]),
    );
  });

  it("scan --verbose shows the skip reason to the user", async () => {
    const sb = makeSandbox();
    const marker = join(sb.base, "pwned-cli");
    trappedProject(sb, "evil", marker);
    const r = await cli(sb, ["scan", "--verbose", ...baseArgs(sb)]);
    expect(r.out).toContain("inside a git repository whose config defines commands (filter.evil.clean)");
    expect(existsSync(marker)).toBe(false);
  });

  it("a normal repository in the same root is still offered", async () => {
    const sb = makeSandbox();
    trappedProject(sb, "evil", join(sb.base, "pwned-mixed"));
    const good = makeProject(join(sb.projects, "good"), { git: true, ageDays: 60 });
    const deps = testDeps();
    const result = await scan(await makeConfig(sb, {}, deps), deps);
    expect(result.fs.map((c) => c.path)).toEqual([join(good, "node_modules")]);
  });
});
