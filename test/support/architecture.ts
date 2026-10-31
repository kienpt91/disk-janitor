import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

export type Layer = "domain" | "application" | "infrastructure" | "composition" | "entry" | "legacy";

export interface SourceFile {
  /** Path relative to src, with forward slashes, e.g. "domain/shared/escape.ts". */
  path: string;
  text: string;
}

export interface Violation {
  file: string;
  rule: string;
  detail: string;
}

export function layerOf(path: string): Layer {
  const top = path.split("/")[0] as string;
  if (top === "domain" || top === "application" || top === "infrastructure" || top === "composition") return top;
  if (path === "index.ts") return "entry";
  return "legacy";
}

export function loadSources(srcDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push({ path: relative(srcDir, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(srcDir);
  return out;
}

/** Remove comments and string-literal contents that are not import specifiers (good enough for token rules). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

export function importsOf(text: string): string[] {
  const out: string[] = [];
  const clean = stripComments(text);
  for (const m of clean.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2] ?? m[3]) as string);
  return out;
}

/** Tokens that mean a pure layer reads the clock, randomness, the process or the outside world. */
const IMPURE_TOKENS: Array<[RegExp, string]> = [
  [/\bprocess\s*\./, "process"],
  [/\bDate\.now\s*\(/, "Date.now()"],
  [/\bnew Date\s*\(\s*\)/, "new Date() (reads the clock)"],
  [/\bMath\.random\s*\(/, "Math.random()"],
  [/\brandomBytes\b|\brandomUUID\b|\brandomInt\b/, "crypto randomness"],
  [/\bperformance\.now\b/, "performance.now()"],
  [/\bsetTimeout\b|\bsetInterval\b/, "timers"],
  [/\bfetch\s*\(/, "network"],
  [/\brequire\s*\(/, "require()"],
];

const DOMAIN_BUILTINS = new Set(["node:path"]);
const APPLICATION_BUILTINS = new Set(["node:path"]);

/**
 * Driving adapters (the CLI and the MCP server) sit at the edge: they receive requests and call the
 * composition API. Every other infrastructure module is a driven adapter (file system, git, state
 * files...), which implements a port and never reaches for the composition root.
 */
export function isDrivingAdapter(path: string): boolean {
  return path.startsWith("infrastructure/cli/") || path.startsWith("infrastructure/mcp/");
}

export function findViolations(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    const layer = layerOf(f.path);
    if (layer === "legacy" || layer === "entry" || layer === "composition") continue;
    const add = (rule: string, detail: string) => violations.push({ file: f.path, rule, detail });
    for (const spec of importsOf(f.text)) {
      if (spec.startsWith(".")) {
        const target = normalize(join(dirname(f.path), spec)).split("\\").join("/");
        const targetLayer = layerOf(target);
        if (layer === "domain" && targetLayer !== "domain") add("domain-depends-only-on-domain", `imports ${spec} (${targetLayer})`);
        if (layer === "application" && targetLayer !== "domain" && targetLayer !== "application") {
          add("application-depends-only-inward", `imports ${spec} (${targetLayer})`);
        }
        if (layer === "infrastructure" && targetLayer === "composition" && !isDrivingAdapter(f.path)) {
          add("driven-adapters-never-import-composition", `imports ${spec}`);
        }
        if (layer === "infrastructure" && targetLayer === "legacy") add("infrastructure-never-imports-legacy", `imports ${spec}`);
        continue;
      }
      if (layer === "domain") {
        const allowedCrypto = f.path === "domain/shared/canonical.ts" && spec === "node:crypto";
        if (!DOMAIN_BUILTINS.has(spec) && !allowedCrypto) add("domain-has-no-io-dependencies", `imports ${spec}`);
      }
      if (layer === "application" && !APPLICATION_BUILTINS.has(spec)) add("application-has-no-io-dependencies", `imports ${spec}`);
    }
    if (layer === "domain" || layer === "application") {
      const clean = stripComments(f.text);
      for (const [re, what] of IMPURE_TOKENS) {
        if (re.test(clean)) add(`${layer}-is-deterministic`, `uses ${what}`);
      }
    }
    if (f.path === "domain/shared/canonical.ts") {
      const crypto = /import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/.exec(f.text);
      if (crypto && crypto[1]?.split(",").some((n) => n.trim() !== "createHash")) {
        add("domain-crypto-is-hashing-only", `imports ${crypto[1]?.trim()} from node:crypto`);
      }
    }
  }
  return violations;
}

export function srcRoot(testFileDir: string): string {
  return resolve(testFileDir, "..", "src");
}
