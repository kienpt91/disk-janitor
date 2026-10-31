import { createHash } from "node:crypto";
import { safeJson } from "./escape.js";

/** Deterministic JSON: object keys sorted, no whitespace. Only plain JSON values are accepted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
  return value;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical form with display-unsafe characters escaped; still valid JSON with identical meaning. */
export function canonicalSafeJson(value: unknown): string {
  return safeJson(sortKeys(value));
}
