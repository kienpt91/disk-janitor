// Repositories are untrusted input. A repository's own configuration can name programs that git
// runs while answering harmless-looking questions (a clean filter runs during `git status`, a
// textconv or external diff during diff, hooks, fsmonitor, a pager, an ssh or credential helper).
// Discovery therefore refuses any repository whose local configuration defines such a command,
// before it asks git anything that could run it.

import { escapeText } from "../shared/escape.js";

/** Configuration names (as `git config --list` prints them, lower-cased section and variable) that make git execute a program. */
const COMMAND_KEYS: readonly RegExp[] = [
  /^filter\./i,
  /^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy)$/i,
  /^diff\..*\.(textconv|command)$/i,
  /^merge\..*\.driver$/i,
  /^include\./i,
  /^includeif\./i,
  /^credential\.(.*\.)?helper$/i,
];

/** Scopes that belong to the repository itself (not to the user, the machine, or our own `-c` flags). */
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);

/**
 * The names of the repository's own settings in `git config --list -z --show-scope` output:
 * NUL-separated `scope`, then `name\nvalue` (or just `name` for a valueless setting). Settings of
 * any other scope (global, system, the vendor's built-in file, command line) are not the
 * repository's and are left out.
 */
export function parseRepositoryConfigKeys(stdout: string): string[] {
  const fields = stdout.split("\0");
  const keys: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!REPOSITORY_SCOPES.has(fields[i] as string)) continue;
    const record = fields[i + 1] as string;
    const newline = record.indexOf("\n");
    keys.push(newline < 0 ? record : record.slice(0, newline));
  }
  return keys;
}

/** The first configuration name that defines a command, or null when the configuration is inert. */
export function commandKey(keys: readonly string[]): string | null {
  for (const key of keys) {
    if (COMMAND_KEYS.some((re) => re.test(key))) return key;
  }
  return null;
}

/** Why a repository is refused: names the offending key (escaped, since it came from the repository). */
export function untrustedConfigReason(key: string): string {
  return `inside a git repository whose config defines commands (${escapeText(key, 120)})`;
}
