import { describe, expect, it } from "vitest";
import { BUILD_OUTPUTS, LOCKFILES, cachePaths, CACHE_LOCATIONS } from "../../../src/domain/discovery/catalog.js";
import { catalogFactsRefusal, expectedCatalogItem, type CatalogExpectation, type CatalogFacts } from "../../../src/domain/discovery/catalog-match.js";
import { DETECTOR_IDS } from "../../../src/domain/model/types.js";

const ROOT = "/home/u/projects";
const HOME = "/home/u";
const config = { roots: [ROOT], home: HOME, detectors: [...DETECTOR_IDS] };
const none: CatalogFacts = { regularFiles: new Set(), pythonSource: false, gitEntry: false };
const files = (...names: string[]): CatalogFacts => ({ ...none, regularFiles: new Set(names) });

function need(detector: string, path: string, cfg = config): Exclude<CatalogExpectation, { kind: "refused" }> {
  const e = expectedCatalogItem(cfg, { detector: detector as never, path });
  if (e.kind === "refused") throw new Error(`unexpected refusal: ${e.reason}`);
  return e;
}
const refused = (detector: string, path: string, cfg = config): string | null => {
  const e = expectedCatalogItem(cfg, { detector: detector as never, path });
  return e.kind === "refused" ? e.reason : null;
};

describe("catalogue match: which detectors may produce file-system candidates", () => {
  it.each(["docker", "git-worktrees"])("refuses the %s detector", (d) => {
    expect(refused(d, `${ROOT}/a/node_modules`)).toBe(`detector ${d} does not produce file-system candidates`);
  });
});

describe("catalogue match: node_modules", () => {
  const nm = `${ROOT}/app/node_modules`;

  it("expects package.json and a lockfile next to it, in the project directory", () => {
    const e = need("node-modules", nm);
    expect(e).toMatchObject({ kind: "node-modules", projectDir: `${ROOT}/app` });
    expect((e as { files: string[] }).files).toEqual(["package.json", ...LOCKFILES.map((l) => l.name)]);
  });

  it("accepts package.json plus any one lockfile from the catalogue", () => {
    for (const l of LOCKFILES) expect(catalogFactsRefusal(need("node-modules", nm), files("package.json", l.name))).toBeNull();
  });

  it("refuses a name other than node_modules", () => {
    expect(refused("node-modules", `${ROOT}/app/notes`)).toBe("its name is not node_modules");
    expect(refused("node-modules", `${ROOT}/app/node_modules2`)).toBe("its name is not node_modules");
    expect(refused("node-modules", `${ROOT}/app/Node_Modules`)).toBe("its name is not node_modules");
  });

  it("refuses without package.json", () => {
    expect(catalogFactsRefusal(need("node-modules", nm), files("package-lock.json"))).toBe("no package.json next to it, so it is not a recognised project");
  });

  it("refuses without a lockfile", () => {
    expect(catalogFactsRefusal(need("node-modules", nm), files("package.json", "README.md"))).toBe("no lockfile next to it, so the install is not reproducible");
  });

  it("refuses a project directory outside the root (node_modules directly under a filesystem root)", () => {
    expect(refused("node-modules", "/node_modules", { ...config, roots: ["/node_modules"] })).toBe("its project directory is outside the configured root");
  });

  it("accepts node_modules directly inside the root (the root is the project)", () => {
    expect(need("node-modules", `${ROOT}/node_modules`)).toMatchObject({ projectDir: ROOT });
  });
});

describe("catalogue match: build output", () => {
  it.each(BUILD_OUTPUTS.map((b) => [b.rel.join("/"), b] as const))("recognises %s below a project directory", (_label, spec) => {
    const e = need("build-output", `${ROOT}/proj/${spec.rel.join("/")}`);
    expect(e).toMatchObject({ kind: "build-output", projectDir: `${ROOT}/proj` });
    expect((e as { files: string[] }).files).toEqual([...spec.manifests]);
    expect((e as { pythonSource: boolean }).pythonSource).toBe(spec.pySibling === true);
  });

  it("refuses names outside the catalogue", () => {
    expect(refused("build-output", `${ROOT}/proj/notes`)).toBe("its path below the project directory is not a catalogued build output");
    expect(refused("build-output", `${ROOT}/proj/src`)).toBe("its path below the project directory is not a catalogued build output");
  });

  it("refuses a catalogue name at the wrong depth (the rel must match exactly)", () => {
    expect(refused("build-output", `${ROOT}/proj/vite`)).toBe("its path below the project directory is not a catalogued build output");
    expect(refused("build-output", `${ROOT}/proj/other/vite`)).toBe("its path below the project directory is not a catalogued build output");
  });

  it("a sibling manifest from the spec identifies the project", () => {
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/dist`), files("package.json"))).toBeNull();
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/target`), files("Cargo.toml"))).toBeNull();
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/.next`), files("package.json"))).toBeNull();
  });

  it("a manifest of another spec does not count", () => {
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/target`), files("package.json"))).toMatch(/^no sibling manifest identifies the project type and no \.git entry/);
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/.next`), files("Cargo.toml"))).not.toBeNull();
  });

  it("a python sibling identifies python caches", () => {
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/__pycache__`), { ...none, pythonSource: true })).toBeNull();
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/.pytest_cache`), { ...none, pythonSource: true })).toBeNull();
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/dist`), { ...none, pythonSource: true })).not.toBeNull();
  });

  it("a .git entry in the project directory or an ancestor inside the root identifies the project instead", () => {
    const e = need("build-output", `${ROOT}/mono/pkg/dist`);
    expect((e as { gitDirs: string[] }).gitDirs).toEqual([`${ROOT}/mono/pkg`, `${ROOT}/mono`, ROOT]);
    expect(catalogFactsRefusal(e, { ...none, gitEntry: true })).toBeNull();
  });

  it("the .git search stops at the root", () => {
    const e = need("build-output", `${ROOT}/p/dist`);
    expect((e as { gitDirs: string[] }).gitDirs).not.toContain(HOME);
    expect((e as { gitDirs: string[] }).gitDirs).toEqual([`${ROOT}/p`, ROOT]);
  });

  it("with neither manifest nor .git the refusal says git ignore state is not re-checked at apply", () => {
    expect(catalogFactsRefusal(need("build-output", `${ROOT}/p/dist`), none)).toBe(
      "no sibling manifest identifies the project type and no .git entry was found (git ignore state is not re-checked at apply)",
    );
  });

  it("refuses a project directory outside the root", () => {
    expect(refused("build-output", "/dist", { ...config, roots: ["/dist"] })).toBe("its project directory is outside the configured root");
  });
});

describe("catalogue match: package caches", () => {
  const npm = `${HOME}/.npm/_cacache`;

  it("accepts exactly the documented cache locations below home", () => {
    for (const p of cachePaths(HOME)) expect(need("package-cache", p)).toEqual({ kind: "exact" });
    expect(cachePaths(HOME)).toHaveLength(CACHE_LOCATIONS.length);
  });

  it("refuses any other path, a parent or a child of a cache location", () => {
    expect(refused("package-cache", `${HOME}/.npm`)).toBe("it is not one of the documented package-manager cache locations");
    expect(refused("package-cache", `${npm}/content-v2`)).toBe("it is not one of the documented package-manager cache locations");
    expect(refused("package-cache", `${ROOT}/a/.npm/_cacache`)).toBe("it is not one of the documented package-manager cache locations");
    expect(refused("package-cache", `${HOME}/Documents`)).toBe("it is not one of the documented package-manager cache locations");
  });

  it("refuses a cache location of another home", () => {
    expect(refused("package-cache", "/home/other/.npm/_cacache")).toBe("it is not one of the documented package-manager cache locations");
  });

  it("refuses when the package-cache detector is not enabled", () => {
    expect(refused("package-cache", npm, { ...config, detectors: ["node-modules"] })).toBe("the package-cache detector is not enabled");
  });
});

describe("catalogue match: a path is judged by its declared detector only", () => {
  it("a node_modules path declared as build-output is not a build output", () => {
    expect(refused("build-output", `${ROOT}/a/node_modules`)).toBe("its path below the project directory is not a catalogued build output");
  });
  it("a dist path declared as node-modules is not node_modules", () => {
    expect(refused("node-modules", `${ROOT}/a/dist`)).toBe("its name is not node_modules");
  });
});
