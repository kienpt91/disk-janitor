#!/usr/bin/env node
import { escapeText } from "../../domain/shared/escape.js";
import { realIO, runCli } from "./cli.js";

runCli(process.argv.slice(2), realIO()).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fatal: ${escapeText(e instanceof Error ? e.message : String(e))}\n`);
    process.exitCode = 1;
  },
);
