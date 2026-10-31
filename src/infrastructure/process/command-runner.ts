import { execFile } from "node:child_process";

export interface CommandResult {
  /** Exit code; null when the process could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when spawning failed (ENOENT), timed out or exceeded the output limit. */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Runs a program with an argument vector. Never goes through a shell. */
export type CommandRunner = (command: string, args: readonly string[], opts?: RunOptions) => Promise<CommandResult>;

const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

export const runCommand: CommandRunner = (command, args, opts = {}) =>
  new Promise((resolveResult) => {
    const env: Record<string, string> = { LANG: "C", LC_ALL: "C" };
    for (const key of PASS_ENV) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, opts.env ?? {});
    execFile(
      command,
      [...args],
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolveResult({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (typeof e.code === "number") return resolveResult({ code: e.code, stdout: stdout ?? "", stderr: stderr ?? "" });
        const error = e.killed ? "timeout" : String(e.code ?? e.message);
        resolveResult({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", error });
      },
    );
  });
