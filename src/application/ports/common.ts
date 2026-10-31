// Ports shared by every use case. The application layer talks to the outside world only through
// interfaces declared in src/application/ports; infrastructure adapters implement them.

import type { DomainEvent } from "../../domain/events.js";

/** What the use cases need to know about a file system entry (a subset of fs.BigIntStats). */
export interface FileStat {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  blocks: bigint;
  mtimeMs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The few file system operations that decide what is inspected and what is moved. Never follows
 * symlinks (lstat); rename must fail rather than copy across devices.
 */
export interface FileSystem {
  lstat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Source of randomness and identifiers (kept out of the domain). */
export interface IdSource {
  /** Random lowercase hex of `bytes` bytes. */
  hex(bytes: number): string;
}

/** Receives domain events. The infrastructure adapter appends them to the hash-chained audit log. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

/** Test seams fired inside apply. Never configured from the CLI or MCP. */
export interface ApplyHooks {
  /** After every candidate passed validation, before the first rename. */
  afterValidate?: () => Promise<void> | void;
  /** Immediately before candidate `path` is renamed (after the last quick re-check). */
  beforeRename?: (path: string) => Promise<void> | void;
}

export interface Lease {
  release(): Promise<void>;
}

/** Mutual exclusion for apply. `acquire` rejects with LockHeldError (domain) when already held. */
export interface ApplyLock {
  acquire(): Promise<Lease>;
}
