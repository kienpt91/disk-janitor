import { dirname, join, normalize, sep } from "node:path";
import type { FileStat, FileSystem } from "../../../src/application/ports/common.js";

type Node =
  | { kind: "dir"; ino: bigint; dev: bigint; mtimeMs: bigint; children: Map<string, Node> }
  | { kind: "file"; ino: bigint; dev: bigint; mtimeMs: bigint; bytes: number; links: { count: number } }
  | { kind: "symlink"; ino: bigint; dev: bigint; mtimeMs: bigint; target: string };

class Stat implements FileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly blocks: bigint;
  readonly mtimeMs: bigint;
  constructor(private readonly node: Node) {
    this.dev = node.dev;
    this.ino = node.ino;
    this.mtimeMs = node.mtimeMs;
    this.nlink = node.kind === "file" ? BigInt(node.links.count) : 1n;
    this.blocks = node.kind === "file" ? BigInt(Math.ceil(node.bytes / 512)) : node.kind === "dir" ? 8n : 0n;
  }
  isDirectory(): boolean {
    return this.node.kind === "dir";
  }
  isFile(): boolean {
    return this.node.kind === "file";
  }
  isSymbolicLink(): boolean {
    return this.node.kind === "symlink";
  }
}

function enoent(path: string, syscall = "lstat"): NodeJS.ErrnoException {
  const e = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

function err(code: string, path: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/**
 * In-memory FileSystem for application tests: directories, regular files (size, mtime, hard-link
 * groups), symlinks and per-subtree device numbers. lstat never follows the final component;
 * realpath resolves symlinks. Paths are POSIX absolute.
 */
export class MemoryFileSystem implements FileSystem {
  private nextIno = 1n;
  private readonly root: Node = this.makeDir(1n, 0n);
  /** Every rename performed, for assertions. */
  readonly renames: Array<[string, string]> = [];

  private makeDir(dev: bigint, mtime: bigint): Node {
    return { kind: "dir", ino: this.nextIno++, dev, mtimeMs: mtime, children: new Map() };
  }

  private split(path: string): string[] {
    const p = normalize(path);
    if (!p.startsWith(sep)) throw new Error(`MemoryFileSystem needs absolute paths: ${path}`);
    return p.split(sep).filter((s) => s.length > 0);
  }

  /** Resolve to a node. `followLast` follows a trailing symlink (used by realpath only). */
  private resolve(path: string, followLast: boolean, hops = 0): { node: Node; real: string } {
    if (hops > 32) throw err("ELOOP", path);
    let node: Node = this.root;
    let real = "";
    const parts = this.split(path);
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] as string;
      if (node.kind !== "dir") throw err("ENOTDIR", path);
      const child = node.children.get(name);
      if (!child) throw enoent(path);
      const last = i === parts.length - 1;
      if (child.kind === "symlink" && (!last || followLast)) {
        const target = child.target.startsWith(sep) ? child.target : join(real || sep, child.target);
        const rest = parts.slice(i + 1).join(sep);
        return this.resolve(rest ? join(target, rest) : target, followLast, hops + 1);
      }
      node = child;
      real += sep + name;
    }
    return { node, real: real || sep };
  }

  private parentOf(path: string): { dir: Extract<Node, { kind: "dir" }>; name: string } {
    const parts = this.split(path);
    const name = parts.pop();
    if (name === undefined) throw err("EINVAL", path);
    const parent = this.resolve(sep + parts.join(sep), true).node;
    if (parent.kind !== "dir") throw err("ENOTDIR", path);
    return { dir: parent, name };
  }

  // ---- builder API ----
  mkdir(path: string, opts: { mtimeMs?: number; dev?: bigint } = {}): this {
    let cur: Node = this.root;
    let dev = this.root.dev;
    for (const name of this.split(path)) {
      if (cur.kind !== "dir") throw err("ENOTDIR", path);
      let next = cur.children.get(name);
      if (!next) {
        next = this.makeDir(dev, BigInt(opts.mtimeMs ?? 0));
        cur.children.set(name, next);
      }
      cur = next;
      dev = cur.dev;
    }
    if (opts.dev !== undefined && cur.kind === "dir") cur.dev = opts.dev;
    if (opts.mtimeMs !== undefined) cur.mtimeMs = BigInt(opts.mtimeMs);
    return this;
  }

  writeFile(path: string, opts: { bytes?: number; mtimeMs?: number } = {}): this {
    this.mkdir(dirname(path));
    const { dir, name } = this.parentOf(path);
    dir.children.set(name, { kind: "file", ino: this.nextIno++, dev: dir.dev, mtimeMs: BigInt(opts.mtimeMs ?? 0), bytes: opts.bytes ?? 1, links: { count: 1 } });
    return this;
  }

  /** Hard link: `to` becomes another name of the file at `from` (shared inode, nlink incremented). */
  link(from: string, to: string): this {
    const src = this.resolve(from, false).node;
    if (src.kind !== "file") throw err("EPERM", from);
    this.mkdir(dirname(to));
    const { dir, name } = this.parentOf(to);
    src.links.count++;
    dir.children.set(name, { ...src, links: src.links });
    return this;
  }

  symlink(path: string, target: string): this {
    this.mkdir(dirname(path));
    const { dir, name } = this.parentOf(path);
    dir.children.set(name, { kind: "symlink", ino: this.nextIno++, dev: dir.dev, mtimeMs: 0n, target });
    return this;
  }

  setMtime(path: string, mtimeMs: number): this {
    this.resolve(path, false).node.mtimeMs = BigInt(mtimeMs);
    return this;
  }

  /** Give `path` and everything created below it afterwards a different device number. */
  setDev(path: string, dev: bigint): this {
    const set = (n: Node) => {
      n.dev = dev;
      if (n.kind === "dir") for (const c of n.children.values()) set(c);
    };
    set(this.resolve(path, false).node);
    return this;
  }

  /** Remove an entry (test setup only). */
  remove(path: string): this {
    const { dir, name } = this.parentOf(path);
    dir.children.delete(name);
    return this;
  }

  exists(path: string): boolean {
    try {
      this.resolve(path, false);
      return true;
    } catch {
      return false;
    }
  }

  list(path: string): string[] {
    const n = this.resolve(path, true).node;
    return n.kind === "dir" ? [...n.children.keys()].sort() : [];
  }

  // ---- FileSystem port ----
  async lstat(path: string): Promise<FileStat> {
    return new Stat(this.resolve(path, false).node);
  }

  async readdir(path: string): Promise<string[]> {
    const { node } = this.resolve(path, true);
    if (node.kind !== "dir") throw err("ENOTDIR", path);
    return [...node.children.keys()];
  }

  async realpath(path: string): Promise<string> {
    return this.resolve(path, true).real;
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.parentOf(from);
    const node = src.dir.children.get(src.name);
    if (!node) throw enoent(from, "rename");
    const dst = this.parentOf(to);
    if (dst.dir.dev !== node.dev) throw err("EXDEV", to);
    const existing = dst.dir.children.get(dst.name);
    if (existing && (existing.kind !== "dir" || node.kind !== "dir" || existing.children.size > 0)) throw err("EEXIST", to);
    src.dir.children.delete(src.name);
    dst.dir.children.set(dst.name, node);
    this.renames.push([from, to]);
  }
}
