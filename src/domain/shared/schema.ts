// A very small strict schema validator. Plan files, approval records, manifests and config
// files are all read through it: unknown keys are rejected, sizes and string lengths are bounded.

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export type Parser<T> = ((value: unknown, path: string) => T) & { optional?: boolean };

export type Infer<P> = P extends Parser<infer T> ? T : never;

const here = (p: string) => (p === "" ? "value" : p);

export function str(opts: { max?: number; min?: number; pattern?: RegExp } = {}): Parser<string> {
  return (v, p) => {
    if (typeof v !== "string") throw new SchemaError(`${here(p)}: expected string`);
    if (v.length > (opts.max ?? 4096)) throw new SchemaError(`${here(p)}: string too long`);
    if (v.length < (opts.min ?? 0)) throw new SchemaError(`${here(p)}: string too short`);
    if (v.includes("\0")) throw new SchemaError(`${here(p)}: NUL byte in string`);
    if (opts.pattern && !opts.pattern.test(v)) throw new SchemaError(`${here(p)}: does not match the required format`);
    return v;
  };
}

export function int(opts: { min?: number; max?: number } = {}): Parser<number> {
  return (v, p) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new SchemaError(`${here(p)}: expected safe integer`);
    if (v < (opts.min ?? 0)) throw new SchemaError(`${here(p)}: below minimum`);
    if (v > (opts.max ?? Number.MAX_SAFE_INTEGER)) throw new SchemaError(`${here(p)}: above maximum`);
    return v;
  };
}

export function bool(): Parser<boolean> {
  return (v, p) => {
    if (typeof v !== "boolean") throw new SchemaError(`${here(p)}: expected boolean`);
    return v;
  };
}

export function literal<T extends string | number>(...allowed: T[]): Parser<T> {
  return (v, p) => {
    if (!allowed.includes(v as T)) throw new SchemaError(`${here(p)}: unexpected value`);
    return v as T;
  };
}

export function arr<T>(item: Parser<T>, opts: { max?: number } = {}): Parser<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) throw new SchemaError(`${here(p)}: expected array`);
    if (v.length > (opts.max ?? 10_000)) throw new SchemaError(`${here(p)}: too many items`);
    return v.map((x, i) => item(x, `${p}[${i}]`));
  };
}

export type OptParser<T> = ((value: unknown, path: string) => T | undefined) & { optional: true };

export function opt<T>(inner: Parser<T>): OptParser<T> {
  const parser = ((v: unknown, p: string) => (v === undefined ? undefined : inner(v, p))) as OptParser<T>;
  parser.optional = true;
  return parser;
}

type OptionalKeys<S> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type Shape<S extends Record<string, Parser<unknown>>> = {
  [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> };

export function obj<S extends Record<string, Parser<unknown>>>(shape: S): Parser<Shape<S>> {
  return (v, p) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SchemaError(`${here(p)}: expected object`);
    const record = v as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) throw new SchemaError(`${p ? p + "." : ""}${key}: unknown key`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, parser] of Object.entries(shape)) {
      const present = Object.prototype.hasOwnProperty.call(record, key);
      if (!present) {
        if (parser.optional) continue;
        throw new SchemaError(`${p ? p + "." : ""}${key}: required`);
      }
      const parsed = parser(record[key], p ? `${p}.${key}` : key);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out as Shape<S>;
  };
}

/** One of several object shapes, selected by a string discriminator. */
export function union<T>(tag: string, variants: Record<string, Parser<T>>): Parser<T> {
  return (v, p) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SchemaError(`${here(p)}: expected object`);
    const t = (v as Record<string, unknown>)[tag];
    if (typeof t !== "string" || !Object.prototype.hasOwnProperty.call(variants, t)) {
      throw new SchemaError(`${p ? p + "." : ""}${tag}: unknown variant`);
    }
    return (variants[t] as Parser<T>)(v, p);
  };
}

/** Parse JSON text under a byte limit and validate it. */
export function parseJson<T>(text: string, parser: Parser<T>, maxBytes: number, what: string): T {
  if (new TextEncoder().encode(text).length > maxBytes) throw new SchemaError(`${what}: larger than ${maxBytes} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SchemaError(`${what}: not valid JSON`);
  }
  try {
    return parser(raw, "");
  } catch (e) {
    if (e instanceof SchemaError) throw new SchemaError(`${what}: ${e.message}`);
    throw e;
  }
}
