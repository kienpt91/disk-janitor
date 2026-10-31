// Composition root for configuration and planning: wires adapters to the application use cases and
// keeps the Deps-based convenience API used by the CLI, the MCP server, the tests and library users.
import { homedir } from "node:os";
import { resolveConfig as resolveConfigUseCase } from "../application/config.js";
import type { Config, RawConfig } from "../domain/model/config.js";
import type { Deps } from "./deps.js";

export interface ResolveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve user input into a validated Config using the real process environment unless overridden. */
export async function resolveConfig(raw: RawConfig, deps: Deps, opts: ResolveOptions = {}): Promise<Config> {
  return resolveConfigUseCase(raw, deps, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    homeDir: homedir(),
  });
}
