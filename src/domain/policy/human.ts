export class HumanRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanRequiredError";
  }
}

/** Environment variables that mark a non-interactive or agent-driven session. */
export const AGENT_ENV_MARKERS = ["DISK_JANITOR_AGENT", "DISK_JANITOR_NONINTERACTIVE", "AGENT_SESSION", "NONINTERACTIVE", "CI"] as const;

export interface HumanSession {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

function flagged(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "no";
}

/**
 * Human-only gate. Requires a TTY on both stdin and stdout and no agent/non-interactive marker in
 * the environment. This stops accidents and ordinary agent runs; it is not a sandbox (see SECURITY.md).
 */
export function assertHumanSession(io: HumanSession, what: string): void {
  if (!io.stdinIsTTY || !io.stdoutIsTTY) {
    throw new HumanRequiredError(`${what} needs an interactive terminal on stdin and stdout; refusing in a non-interactive session`);
  }
  for (const name of AGENT_ENV_MARKERS) {
    if (flagged(io.env[name])) {
      throw new HumanRequiredError(`${what} refuses to run while ${name} is set: this step is for a human at a terminal`);
    }
  }
}

export function digestPrefix(digest: string): string {
  return digest.slice(0, 8);
}

/** Does what the human typed match the expected confirmation code? */
export function confirmationMatches(expected: string, typed: string): boolean {
  return typed.trim() === expected;
}
