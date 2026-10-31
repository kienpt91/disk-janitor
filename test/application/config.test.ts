import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/application/config.js";
import { validateRoots } from "../../src/application/validate-roots.js";
import type { RawConfig } from "../../src/domain/model/config.js";
import { RootsError } from "../../src/domain/policy/roots.js";
import { MemoryFileSystem } from "../support/fakes/memory-fs.js";

const HOME = "/work/dev";
const CWD = "/work/dev/projects";

function fsWorld(): MemoryFileSystem {
  return new MemoryFileSystem().mkdir(`${HOME}/projects/app`).mkdir(`${HOME}/projects/lib`).mkdir(`${HOME}/code`).mkdir("/data/repos");
}

const resolveWith = (raw: RawConfig, fs: MemoryFileSystem, env: Record<string, string | undefined> = {}, cwd = CWD, homeDir = HOME) =>
  resolveConfig(raw, { fs }, { cwd, env, homeDir });

describe("resolveConfig", () => {
  it("resolves absolute roots, the home and the default state directory", async () => {
    const c = await resolveWith({ roots: [`${HOME}/projects`] }, fsWorld());
    expect(c.roots).toEqual([`${HOME}/projects`]);
    expect(c.home).toBe(HOME);
    expect(c.stateDir).toBe(`${HOME}/.local/state/disk-janitor`);
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves relative roots against the working directory", async () => {
    const c = await resolveWith({ roots: ["app", "./lib", "../code"] }, fsWorld());
    expect(c.roots).toEqual([`${HOME}/code`, `${HOME}/projects/app`, `${HOME}/projects/lib`]);
  });

  it("canonicalizes a symlinked root and keeps only the real path", async () => {
    const fs = fsWorld().symlink(`${HOME}/projects/shortcut`, "/data/repos");
    const c = await resolveWith({ roots: [`${HOME}/projects/shortcut`] }, fs);
    expect(c.roots).toEqual(["/data/repos"]);
  });

  it("sorts roots and collapses duplicates that resolve to the same directory", async () => {
    const fs = fsWorld().symlink(`${HOME}/projects/alias`, `${HOME}/projects/app`);
    const c = await resolveWith({ roots: [`${HOME}/projects/lib`, `${HOME}/projects/app`, `${HOME}/projects/alias`] }, fs);
    expect(c.roots).toEqual([`${HOME}/projects/app`, `${HOME}/projects/lib`]);
  });

  it("requires at least one root", async () => {
    await expect(resolveWith({}, fsWorld())).rejects.toThrow(RootsError);
    await expect(resolveWith({ roots: [] }, fsWorld())).rejects.toThrow("no roots configured: pass at least one --root <dir> (there is no default)");
  });

  it("reports a missing root", async () => {
    await expect(resolveWith({ roots: [`${HOME}/projects/missing`] }, fsWorld())).rejects.toThrow(`root does not exist: "${HOME}/projects/missing"`);
  });

  it("refuses a file used as a root", async () => {
    const fs = fsWorld().writeFile(`${HOME}/projects/notes.txt`);
    await expect(resolveWith({ roots: [`${HOME}/projects/notes.txt`] }, fs)).rejects.toThrow(`root is not a directory: "${HOME}/projects/notes.txt"`);
  });

  it("refuses a symlink to a file", async () => {
    const fs = fsWorld().writeFile("/data/file").symlink(`${HOME}/projects/ln`, "/data/file");
    await expect(resolveWith({ roots: [`${HOME}/projects/ln`] }, fs)).rejects.toThrow("root is not a directory");
  });

  it("refuses the home directory, a symlink to it, and a parent of it", async () => {
    const fs = fsWorld().symlink("/data/home-link", HOME);
    await expect(resolveWith({ roots: [HOME] }, fs)).rejects.toThrow("home directory itself");
    await expect(resolveWith({ roots: ["/data/home-link"] }, fs)).rejects.toThrow("home directory itself");
    await expect(resolveWith({ roots: ["/work"] }, fs)).rejects.toThrow("contains the home directory");
  });

  it("refuses system and protected locations", async () => {
    const fs = fsWorld().mkdir("/usr/local").mkdir(`${HOME}/Documents/code`).mkdir(`${HOME}/projects/.ssh`);
    await expect(resolveWith({ roots: ["/usr/local"] }, fs)).rejects.toThrow("refusing a root inside system location /usr");
    await expect(resolveWith({ roots: [`${HOME}/Documents/code`] }, fs)).rejects.toThrow("protected location");
    await expect(resolveWith({ roots: [`${HOME}/projects/.ssh`] }, fs)).rejects.toThrow(".ssh");
  });

  it("refuses nested roots", async () => {
    await expect(resolveWith({ roots: [`${HOME}/projects`, `${HOME}/projects/app`] }, fsWorld())).rejects.toThrow("roots must not be nested inside each other");
  });

  describe("home", () => {
    it("fails when the invoking user's home does not exist", async () => {
      const fs = new MemoryFileSystem().mkdir("/data/repos");
      await expect(resolveWith({ roots: ["/data/repos"] }, fs, {}, "/data")).rejects.toThrow(`home directory does not exist: ${HOME}`);
    });

    it("fails when the configured home does not exist, resolved against the working directory", async () => {
      await expect(resolveWith({ roots: ["/data/repos"], home: "nowhere" }, fsWorld())).rejects.toThrow(`home directory does not exist: ${CWD}/nowhere`);
    });

    it("uses a configured home (relative to cwd) instead of the invoking user's", async () => {
      const fs = fsWorld().mkdir("/data/otherhome");
      const c = await resolveWith({ roots: ["/data/repos"], home: "/data/otherhome" }, fs);
      expect(c.home).toBe("/data/otherhome");
      expect(c.stateDir).toBe("/data/otherhome/.local/state/disk-janitor");
    });

    it("canonicalizes a symlinked home, and refuses roots that are the literal or the real home", async () => {
      const fs = new MemoryFileSystem().mkdir("/data/dev/projects").symlink("/home-link", "/data/dev");
      const c = await resolveWith({ roots: ["/data/dev/projects"] }, fs, {}, "/", "/home-link");
      expect(c.home).toBe("/data/dev");
      await expect(resolveWith({ roots: ["/data/dev"] }, fs, {}, "/", "/home-link")).rejects.toThrow("home directory itself");
      await expect(resolveWith({ roots: ["/home-link"] }, fs, {}, "/", "/home-link")).rejects.toThrow("home directory itself");
    });

    it("still protects the invoking user's home when another home is configured", async () => {
      const fs = fsWorld().mkdir("/data/otherhome");
      await expect(resolveWith({ roots: [HOME], home: "/data/otherhome" }, fs)).rejects.toThrow("home directory itself");
    });
  });

  describe("state directory", () => {
    it("defaults to XDG_STATE_HOME when it is absolute", async () => {
      const c = await resolveWith({ roots: ["/data/repos"] }, fsWorld(), { XDG_STATE_HOME: "/var/xdg" });
      expect(c.stateDir).toBe("/var/xdg/disk-janitor");
    });

    it("defaults to ~/.local/state when XDG_STATE_HOME is unset, empty or relative", async () => {
      for (const env of [{}, { XDG_STATE_HOME: "" }, { XDG_STATE_HOME: "rel/state" }]) {
        const c = await resolveWith({ roots: ["/data/repos"] }, fsWorld(), env);
        expect(c.stateDir).toBe(`${HOME}/.local/state/disk-janitor`);
      }
    });

    it("an explicit stateDir wins over XDG and is resolved against the working directory", async () => {
      const c = await resolveWith({ roots: ["/data/repos"], stateDir: "../.djstate" }, fsWorld(), { XDG_STATE_HOME: "/var/xdg" });
      expect(c.stateDir).toBe(`${HOME}/.djstate`);
      const abs = await resolveWith({ roots: ["/data/repos"], stateDir: "/var/lib/dj" }, fsWorld());
      expect(abs.stateDir).toBe("/var/lib/dj");
    });

    it("does not require the state directory to exist", async () => {
      const c = await resolveWith({ roots: ["/data/repos"], stateDir: "/not/created/yet" }, fsWorld());
      expect(c.stateDir).toBe("/not/created/yet");
    });
  });

  describe("digest", () => {
    it("is stable across calls", async () => {
      const raw = { roots: [`${HOME}/projects/app`], staleDays: 9 };
      expect((await resolveWith(raw, fsWorld())).digest).toBe((await resolveWith(raw, fsWorld())).digest);
    });

    it("does not depend on the spelling of a root or the order of roots", async () => {
      const fs = fsWorld().symlink("/data/link", `${HOME}/projects/app`);
      const a = await resolveWith({ roots: [`${HOME}/projects/app`, `${HOME}/projects/lib`] }, fs);
      const b = await resolveWith({ roots: ["lib", "/data/link"] }, fs);
      expect(b.digest).toBe(a.digest);
    });

    it("does not depend on the state directory", async () => {
      const a = await resolveWith({ roots: ["/data/repos"] }, fsWorld(), { XDG_STATE_HOME: "/one" });
      const b = await resolveWith({ roots: ["/data/repos"] }, fsWorld(), { XDG_STATE_HOME: "/two" });
      expect(b.digest).toBe(a.digest);
    });

    it("changes with the roots and with thresholds", async () => {
      const base = (await resolveWith({ roots: ["/data/repos"] }, fsWorld())).digest;
      expect((await resolveWith({ roots: [`${HOME}/code`] }, fsWorld())).digest).not.toBe(base);
      expect((await resolveWith({ roots: ["/data/repos"], maxDepth: 3 }, fsWorld())).digest).not.toBe(base);
    });
  });

  it("applies the defaults and overrides from the raw config", async () => {
    const c = await resolveWith({ roots: ["/data/repos"], staleDays: 90, packageCaches: true, dockerApply: true }, fsWorld());
    expect(c.staleDays).toBe(90);
    expect(c.maxDepth).toBe(8);
    expect(c.dockerApply).toBe(true);
    expect(c.detectors).toEqual(["node-modules", "build-output", "package-cache", "docker", "git-worktrees"]);
  });
});

describe("validateRoots", () => {
  it("returns canonical sorted roots", async () => {
    const roots = await validateRoots(["/data/repos", `${HOME}/code`], { homes: [HOME], fs: fsWorld() });
    expect(roots).toEqual(["/data/repos", `${HOME}/code`]);
  });

  it("needs a working directory for a relative root", async () => {
    await expect(validateRoots(["app"], { homes: [HOME], fs: fsWorld() })).rejects.toThrow("a relative root needs a working directory to resolve against");
  });

  it.each([[""], ["a\0b"]])("rejects the root %j", async (root) => {
    await expect(validateRoots([root], { homes: [HOME], fs: fsWorld(), cwd: CWD })).rejects.toThrow("root is empty or contains a NUL byte");
  });

  it("names the first offender and stops", async () => {
    await expect(validateRoots(["/data/repos", "/data/missing-one", "/data/missing-two"], { homes: [HOME], fs: fsWorld() })).rejects.toThrow('root does not exist: "/data/missing-one"');
  });

  it("tolerates a home that does not exist", async () => {
    await expect(validateRoots(["/data/repos"], { homes: ["/no/such/home"], fs: fsWorld() })).resolves.toEqual(["/data/repos"]);
  });

  it("also protects the canonical form of a symlinked home", async () => {
    const fs = fsWorld().mkdir("/real/home").symlink("/link-home", "/real/home");
    await expect(validateRoots(["/real/home"], { homes: ["/link-home"], fs })).rejects.toThrow("home directory itself");
  });

  it("resolves a chain of symlinks", async () => {
    const fs = fsWorld().symlink("/data/one", "/data/two").symlink("/data/two", "/data/repos");
    await expect(validateRoots(["/data/one"], { homes: [HOME], fs })).resolves.toEqual(["/data/repos"]);
  });

  it("does not mistake a symlink loop for a directory", async () => {
    const fs = fsWorld().symlink("/data/a", "/data/b").symlink("/data/b", "/data/a");
    await expect(validateRoots(["/data/a"], { homes: [HOME], fs })).rejects.toThrow("root does not exist");
  });
});
