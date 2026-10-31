import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSafeJson, sha256Hex } from "../src/domain/shared/canonical.js";
import { arr, bool, int, literal, obj, opt, parseJson, SchemaError, str, union } from "../src/domain/shared/schema.js";

const person = obj({ name: str({ max: 8 }), age: int({ min: 0, max: 150 }), tags: arr(str(), { max: 3 }), nick: opt(str()) });

describe("schema primitives", () => {
  it("accepts a valid object and keeps optional keys only when present", () => {
    expect(person({ name: "ann", age: 3, tags: [] }, "")).toEqual({ name: "ann", age: 3, tags: [] });
    expect(person({ name: "ann", age: 3, tags: ["a"], nick: "A" }, "")).toEqual({ name: "ann", age: 3, tags: ["a"], nick: "A" });
  });

  it("treats an explicit undefined optional as absent", () => {
    const out = person({ name: "ann", age: 3, tags: [], nick: undefined }, "");
    expect(Object.keys(out)).not.toContain("nick");
  });

  it("rejects unknown keys", () => {
    expect(() => person({ name: "a", age: 1, tags: [], extra: 1 }, "")).toThrow("extra: unknown key");
  });

  it("rejects missing required keys", () => {
    expect(() => person({ name: "a", tags: [] }, "")).toThrow("age: required");
  });

  it("rejects wrong types with the key path", () => {
    expect(() => person({ name: 5, age: 1, tags: [] }, "")).toThrow("name: expected string");
    expect(() => person({ name: "a", age: "1", tags: [] }, "")).toThrow("age: expected safe integer");
    expect(() => person({ name: "a", age: 1.5, tags: [] }, "")).toThrow("age: expected safe integer");
    expect(() => person({ name: "a", age: 1, tags: "x" }, "")).toThrow("tags: expected array");
    expect(() => person({ name: "a", age: 1, tags: [1] }, "")).toThrow("tags[0]: expected string");
  });

  it("rejects non-objects", () => {
    for (const bad of [null, [], "x", 3, undefined]) {
      expect(() => person(bad, "")).toThrow("value: expected object");
    }
  });

  it("rejects oversize strings and arrays", () => {
    expect(() => person({ name: "123456789", age: 1, tags: [] }, "")).toThrow("name: string too long");
    expect(() => person({ name: "a", age: 1, tags: ["a", "b", "c", "d"] }, "")).toThrow("tags: too many items");
  });

  it("enforces string min length and pattern", () => {
    expect(() => str({ min: 2 })("a", "k")).toThrow("k: string too short");
    expect(() => str({ pattern: /^[a-f0-9]+$/ })("xyz", "k")).toThrow("k: does not match the required format");
    expect(str({ pattern: /^[a-f0-9]+$/ })("abc1", "k")).toBe("abc1");
  });

  it("rejects NUL bytes in strings", () => {
    expect(() => str()("a\0b", "k")).toThrow("k: NUL byte in string");
  });

  it("enforces integer ranges and rejects unsafe integers and NaN", () => {
    expect(() => int({ min: 1 })(0, "n")).toThrow("n: below minimum");
    expect(() => int({ max: 5 })(6, "n")).toThrow("n: above maximum");
    expect(() => int()(Number.MAX_SAFE_INTEGER + 2, "n")).toThrow("expected safe integer");
    expect(() => int()(NaN, "n")).toThrow("expected safe integer");
    expect(() => int()(-1, "n")).toThrow("below minimum");
  });

  it("bool and literal only accept exact values", () => {
    expect(bool()(true, "b")).toBe(true);
    expect(() => bool()("true", "b")).toThrow("b: expected boolean");
    expect(literal("a", "b")("b", "l")).toBe("b");
    expect(() => literal("a", "b")("c", "l")).toThrow("l: unexpected value");
    expect(literal(1, 2)(2, "l")).toBe(2);
  });

  it("ignores inherited keys such as __proto__ and constructor as unknown", () => {
    expect(() => person(JSON.parse('{"__proto__": 1, "name":"a","age":1,"tags":[]}'), "")).toThrow("__proto__: unknown key");
  });

  it("nested paths are dotted", () => {
    const outer = obj({ inner: obj({ n: int() }) });
    expect(() => outer({ inner: { n: "x" } }, "")).toThrow("inner.n: expected safe integer");
    expect(() => outer({ inner: { n: 1, z: 1 } }, "")).toThrow("inner.z: unknown key");
  });
});

describe("union", () => {
  const shape = union<{ kind: string }>("kind", {
    a: obj({ kind: literal("a"), x: int() }),
    b: obj({ kind: literal("b"), y: str() }),
  });

  it("dispatches on the tag", () => {
    expect(shape({ kind: "a", x: 1 }, "")).toEqual({ kind: "a", x: 1 });
    expect(shape({ kind: "b", y: "s" }, "")).toEqual({ kind: "b", y: "s" });
  });

  it("rejects unknown and non-string tags and prototype names", () => {
    expect(() => shape({ kind: "c" }, "")).toThrow("kind: unknown variant");
    expect(() => shape({ kind: 1 }, "")).toThrow("kind: unknown variant");
    expect(() => shape({}, "")).toThrow("kind: unknown variant");
    expect(() => shape({ kind: "toString" }, "")).toThrow("kind: unknown variant");
    expect(() => shape([], "")).toThrow("expected object");
  });

  it("validates the chosen variant strictly", () => {
    expect(() => shape({ kind: "a", x: 1, y: "no" }, "")).toThrow("y: unknown key");
    expect(() => shape({ kind: "a" }, "")).toThrow("x: required");
  });
});

describe("parseJson", () => {
  const p = obj({ n: int() });

  it("parses valid text", () => {
    expect(parseJson('{"n":4}', p, 100, "doc")).toEqual({ n: 4 });
  });

  it("rejects invalid JSON with the document name", () => {
    expect(() => parseJson("{nope", p, 100, "doc")).toThrow(new SchemaError("doc: not valid JSON"));
  });

  it("enforces the byte limit in bytes, not characters", () => {
    const text = JSON.stringify({ n: 1 }) + " ".repeat(10);
    expect(() => parseJson(text, p, 10, "doc")).toThrow("doc: larger than 10 bytes");
    const multi = '{"n":1}' + "é".repeat(10); // 20 bytes of tail
    expect(Buffer.byteLength(multi)).toBe(27);
    expect(() => parseJson(multi, p, 20, "doc")).toThrow("larger than 20 bytes");
  });

  it("prefixes schema errors with the document name", () => {
    expect(() => parseJson('{"n":"x"}', p, 100, "doc")).toThrow("doc: n: expected safe integer");
    expect(() => parseJson('{"n":1,"q":2}', p, 100, "doc")).toThrow("doc: q: unknown key");
  });

  it("throws SchemaError instances", () => {
    expect(() => parseJson("[]", p, 100, "doc")).toThrow(SchemaError);
  });
});

describe("canonical JSON and digest", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}]},"b":1}');
  });

  it("is independent of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow("non-finite number");
    expect(() => canonicalJson([NaN])).toThrow("non-finite number");
  });

  it("canonicalSafeJson escapes bidi characters and still parses to the same value", () => {
    const v = { b: "x\u202ey", a: 1 };
    const text = canonicalSafeJson(v);
    expect(text).toBe('{"a":1,"b":"x\\u202ey"}');
    expect(JSON.parse(text)).toEqual(v);
  });

  it("sha256Hex matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex("abc"));
  });
});
