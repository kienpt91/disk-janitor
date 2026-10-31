// Runs in every test worker before the test files. Points HOME and XDG_STATE_HOME at the sentinel
// fake home so nothing can resolve to a real home directory by accident.
import { join } from "node:path";

const sentinel = process.env["DJ_SENTINEL_HOME"];
if (!sentinel) throw new Error("DJ_SENTINEL_HOME is not set: global setup did not run");
process.env["HOME"] = sentinel;
process.env["XDG_STATE_HOME"] = join(sentinel, ".local", "state");
for (const name of ["CI", "DISK_JANITOR_AGENT", "DISK_JANITOR_NONINTERACTIVE", "AGENT_SESSION", "NONINTERACTIVE"]) {
  delete process.env[name];
}
