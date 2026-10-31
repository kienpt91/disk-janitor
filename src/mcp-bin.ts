#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfigFile } from "./infrastructure/config-file.js";
import { resolveConfig } from "./composition/planning.js";
import { type RawConfig } from "./domain/model/config.js";
import { defaultDeps } from "./composition/deps.js";
import { escapeText } from "./domain/shared/escape.js";
import { createMcpServer } from "./mcp.js";

const HELP = `disk-janitor-mcp: MCP server (stdio) for disk-janitor

Roots and limits come from these flags or --config; MCP tool arguments can never change them.

  --root <dir>        directory to scan (repeatable, required)
  --config <file>     JSON config file (flags override it)
  --state-dir <dir>   state directory
  --home <dir>        home directory for protected paths and package caches
  --caches            include package-manager caches below the home directory
  --docker-apply      allow docker prune of build cache and dangling images after approval
  --stale-days <n>    days a project must be untouched before its node_modules is offered
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string", multiple: true },
      config: { type: "string" },
      "state-dir": { type: "string" },
      home: { type: "string" },
      caches: { type: "boolean" },
      "docker-apply": { type: "boolean" },
      "stale-days": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const cwd = process.cwd();
  const raw: RawConfig = values.config ? { ...(await loadConfigFile(resolve(cwd, values.config))) } : {};
  if (values.root && values.root.length > 0) raw.roots = values.root;
  if (values["state-dir"]) raw.stateDir = values["state-dir"];
  if (values.home) raw.home = values.home;
  if (values.caches) raw.packageCaches = true;
  if (values["docker-apply"]) raw.dockerApply = true;
  if (values["stale-days"] !== undefined) {
    if (!/^[0-9]{1,6}$/.test(values["stale-days"])) throw new Error("--stale-days expects a non-negative integer");
    raw.staleDays = Number(values["stale-days"]);
  }
  // fail fast on bad roots
  await resolveConfig(raw, defaultDeps(), { cwd });
  const server = createMcpServer({ config: raw, cwd });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`disk-janitor-mcp: ${escapeText(e instanceof Error ? e.message : String(e))}\n`);
  process.exitCode = 1;
});
