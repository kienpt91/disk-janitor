import type { ApplyHooks, FileSystem } from "../application/ports/common.js";
import { nodeFs } from "../infrastructure/fs/node-fs.js";
import { runCommand, type CommandRunner } from "../infrastructure/process/command-runner.js";

export interface Deps {
  fs: FileSystem;
  run: CommandRunner;
  now: () => number;
  hooks?: ApplyHooks;
}

export function defaultDeps(): Deps {
  return { fs: nodeFs, run: runCommand, now: () => Date.now() };
}
