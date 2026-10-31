import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findViolations, importsOf, layerOf, loadSources, srcRoot } from "./support/architecture.js";

const sources = loadSources(srcRoot(dirname(fileURLToPath(import.meta.url))));

describe("architecture: the dependency rule holds in the real source tree", () => {
  it("has domain, application and infrastructure layers", () => {
    const layers = new Set(sources.map((s) => layerOf(s.path)));
    expect(layers.has("domain")).toBe(true);
    expect(layers.has("application")).toBe(true);
    expect(layers.has("infrastructure")).toBe(true);
  });

  it("has no dependency-rule violations", () => {
    const violations = findViolations(sources);
    expect(violations.map((v) => `${v.file}: ${v.rule}: ${v.detail}`)).toEqual([]);
  });
});

describe("architecture checker: it really detects violations (self-test on synthetic sources)", () => {
  const check = (path: string, text: string) => findViolations([{ path, text }]).map((v) => v.rule);

  it("flags a domain file importing the application layer", () => {
    expect(check("domain/plan/x.ts", 'import { a } from "../../application/x.js";')).toContain("domain-depends-only-on-domain");
  });

  it("flags a domain file importing infrastructure or node:fs", () => {
    expect(check("domain/x.ts", 'import { b } from "../infrastructure/x.js";')).toContain("domain-depends-only-on-domain");
    expect(check("domain/x.ts", 'import { readFile } from "node:fs/promises";')).toContain("domain-has-no-io-dependencies");
    expect(check("domain/x.ts", 'import { spawn } from "node:child_process";')).toContain("domain-has-no-io-dependencies");
  });

  it("flags clock, randomness and process access in domain and application code", () => {
    expect(check("domain/x.ts", "export const t = Date.now();")).toContain("domain-is-deterministic");
    expect(check("domain/x.ts", "export const r = Math.random();")).toContain("domain-is-deterministic");
    expect(check("domain/x.ts", "export const e = process.env.HOME;")).toContain("domain-is-deterministic");
    expect(check("application/x.ts", "export const t = new Date();")).toContain("application-is-deterministic");
    expect(check("domain/x.ts", "export const d = new Date(5).toISOString();")).toEqual([]);
  });

  it("flags an application file importing infrastructure, composition or node:fs", () => {
    expect(check("application/x.ts", 'import { c } from "../infrastructure/y.js";')).toContain("application-depends-only-inward");
    expect(check("application/x.ts", 'import { c } from "../composition/y.js";')).toContain("application-depends-only-inward");
    expect(check("application/x.ts", 'import { r } from "node:fs";')).toContain("application-has-no-io-dependencies");
  });

  it("allows node:path in pure layers and inward imports everywhere", () => {
    expect(check("domain/x.ts", 'import { join } from "node:path";\nimport { z } from "./y.js";')).toEqual([]);
    expect(check("application/x.ts", 'import { a } from "../domain/y.js";\nimport { b } from "./z.js";')).toEqual([]);
    expect(check("infrastructure/x.ts", 'import { a } from "../domain/y.js";\nimport { r } from "node:fs";')).toEqual([]);
  });

  it("restricts node:crypto in the domain to createHash in the canonical module", () => {
    expect(check("domain/shared/canonical.ts", 'import { createHash } from "node:crypto";')).toEqual([]);
    expect(check("domain/shared/canonical.ts", 'import { createHash, randomBytes } from "node:crypto";')).toContain("domain-crypto-is-hashing-only");
    expect(check("domain/other.ts", 'import { createHash } from "node:crypto";')).toContain("domain-has-no-io-dependencies");
  });

  it("flags infrastructure importing composition", () => {
    expect(check("infrastructure/x.ts", 'import { c } from "../composition/y.js";')).toContain("infrastructure-never-imports-composition");
  });

  it("ignores imports that only appear in comments", () => {
    expect(check("domain/x.ts", '// import { r } from "node:fs";\n/* import "node:net"; */\nexport const a = 1;')).toEqual([]);
  });

  it("parses re-exports and dynamic imports", () => {
    expect(importsOf('export * from "./a.js";\nexport { b } from "./b.js";\nconst m = await import("./c.js");')).toEqual(["./a.js", "./b.js", "./c.js"]);
  });
});
