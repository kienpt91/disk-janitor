# Security

## Reporting a vulnerability

Please use GitHub private vulnerability reporting on the repository, or email kienphan.dev@gmail.com. Do not file public issues for vulnerabilities. A report that shows a path escape, a way to delete or move something outside a configured root, a way to create an approval without a human, or a way to inject text into terminal or MCP output is in scope and treated as high priority.

## What this tool protects against

`disk-janitor` exists so that a coding agent can help reclaim disk space without being able to run an arbitrary delete. The design goals, each covered by tests:

- **No default scope.** There are no default roots. Scanning needs at least one explicit `--root`. Roots that are `/`, the home directory itself, a parent of the home directory, a system directory or a protected location are refused.
- **Read-only first.** `scan` and `plan` never modify anything (a plan is a JSON file in the state directory). `apply` needs a plan, and a plan needs a human approval bound to its SHA-256 digest.
- **Human-only approval.** `approve` and `purge` refuse unless stdin and stdout are both interactive terminals, refuse when an agent or non-interactive marker is present in the environment (`DISK_JANITOR_AGENT`, `DISK_JANITOR_NONINTERACTIVE`, `AGENT_SESSION`, `NONINTERACTIVE`, `CI`), and require typing back a prefix of the plan digest. An approval is an HMAC-SHA256 over the plan digest and an expiry, keyed with a per-user key file (mode 0600), valid 15 minutes by default (60 at most), single-use. The MCP server has no approve tool and no purge tool.
- **Nothing is unlinked by `apply`.** Candidates are moved with `rename` into `<state>/quarantine/<planId>/`, on the same file system only (no copy and delete). A manifest authenticated with the same HMAC key records the original paths so `restore` is a faithful undo and refuses to overwrite. `purge` deletes only items listed in an authenticated manifest, only after a TTL (7 days by default), and only after typed human confirmation.
- **Re-validation at apply time.** Every candidate is checked again against the plan: same device and inode, still a real directory, no symlink anywhere in the parent chain, nothing modified since the plan (the whole tree is re-measured), still inside the roots, not protected, no open file handles (when `lsof` is available). If anything differs the whole apply aborts before the first move. A swap that wins the race between the last check and the rename is detected afterwards by comparing the moved item with the plan and the move is undone.
- **Never follows symlinks.** Walks use `lstat`; symlinks inside candidates are moved along but never traversed or sized; key and audit files are opened with `O_NOFOLLOW`.
- **Protected paths always win.** `.git`, `.ssh`, `.gnupg`, `.aws`, `.config`, keychains, `.env*`, Documents, Desktop, Downloads, Pictures, Music, Movies, iCloud/Dropbox/OneDrive/Google Drive style sync folders, database data directories, names that look like secrets, and any candidate that contains a nested `.git`, an env file, private keys or database markers.
- **Hostile names.** Paths and git/docker output are untrusted. Terminal output escapes control characters, ANSI/OSC sequences and bidi controls; JSON output and plan files escape them as well; MCP output wraps paths in `<untrusted-data>` frames. Plan files, approval records, manifests and config files are parsed with strict schemas and size limits.
- **Tamper evidence.** Every action is appended to a hash-chained JSONL audit log. `apply` refuses to run on a broken chain.

## What this tool does not protect against (threat model limits)

- **A same-user process with a shell can bypass the human gate.** The approval key is a file readable by your user. An agent that can run arbitrary commands as you can read it and forge an approval, or simply run `rm`. The TTY and environment checks stop accidents and ordinary agent runs, not a determined local attacker. Run agents in a sandbox, container or separate account, and keep the state directory (default `~/.local/state/disk-janitor`) out of their reach, if you need a hard boundary.
- **The audit log is tamper-evident, not tamper-proof.** The chain detects edits, deletions and reordering. It cannot detect truncation of the tail or a complete rewrite by someone who can write the file. Record the head hash (`disk-janitor audit` prints it) somewhere else if that matters.
- **Rename races cannot be eliminated without `renameat`.** Node.js has no directory-relative rename. The last re-check and the rename are separated by a very small window; a swap inside it is detected after the fact and undone, but a path component replaced exactly in that window is renamed before it is noticed. `restore` can, in a similarly tiny window, replace an *empty* directory that appeared at the target.
- **The open-file check is best effort.** It needs `lsof`; without it the check is off (`doctor` and `scan` say so). `lsof` run by a non-root user only sees that user's processes.
- **Not a backup.** Quarantined items stay on the same disk until purged; a disk failure or a manual delete of the state directory loses them.
- **Windows is not supported.**

## Dependency policy

Every npm package version, direct and transitive, is published on or before 2026-10-24T00:00:00Z. The lockfile is generated with `npm install --package-lock-only --before=2026-10-24T00:00:00Z --ignore-scripts`, direct dependencies are pinned to exact versions, installs use `npm ci --ignore-scripts` (CI included), and installs, tests, typechecks and builds run in a throwaway container rather than on a developer host. The core (`scan`, `plan`, `apply`, `restore`, `purge`, CLI) uses no runtime dependencies beyond Node.js built-ins. The MCP server uses `@modelcontextprotocol/sdk` and `zod`. `.github/dependabot.yml` uses a 7-day cooldown and ignores semver-major updates of `typescript` and `@types/node`. GitHub Actions are pinned to commit SHAs and the workflow token is read-only.
