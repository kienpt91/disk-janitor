# disk-janitor

**Reclaim disk space with coding agents in the loop, without ever giving them `rm -rf`.**

Agents and dev environments leave a lot of reclaimable junk behind: `node_modules` of stale projects, package-manager caches, build outputs, Docker build cache, toolchain caches. Letting an agent delete it with a shell command is dangerous: one bad path, one symlink, one race and a home directory is gone. `disk-janitor` makes unsafe deletion *structurally hard*:

- **Read-only by default, two phases.** `scan` only looks. `plan` writes a reviewable JSON plan bound to a SHA-256 digest. Nothing moves until an approval exists for that exact digest.
- **An approval step that stops accidental and non-interactive runs.** `approve` needs a real terminal on stdin and stdout, refuses when an agent or non-interactive marker is in the environment, shows *every* candidate, and requires the **full plan digest** typed back (it is not printed on the approve screen; you read it from `explain`). The MCP server has no approve tool and no purge tool. **This is not a security boundary against an agent that runs as your OS user and can drive a pty**: such an agent can run `explain`, read the digest and type it. For a real boundary use `--approver dialog` (an OS confirmation dialog, best effort) or run the tool under a separate OS account; see [Approval: what the gate stops](#approval-what-the-gate-stops-and-what-it-does-not).
- **Quarantine, then purge, with undo.** `apply` only `rename`s directories into a quarantine on the same file system. `restore` is a faithful undo. `purge` (terminal, typed confirmation code) permanently deletes only quarantined items older than a TTL (7 days by default) that an authenticated manifest lists.
- **Strict allowlists.** Five explicit detectors, no "delete big files". A protected-path denylist always wins. Roots must be passed explicitly; `/`, your home directory, its parents and system directories are refused.
- **Re-validation at apply time.** Every candidate is checked again (same device and inode, no symlinks in the parent chain, nothing modified since the plan, still inside the roots, not protected, no open files). If anything differs, the whole apply aborts before the first move.
- **Hash-chained audit log** of every domain event, and hostile file names (newlines, ANSI/OSC escapes, bidi controls, huge names) are escaped everywhere they could reach a terminal, a JSON file or an MCP client.

Platforms: macOS and Linux. Windows is not supported.

> **Not a replacement for backups.** Quarantined items live on the same disk until purged, and no tool that moves files can promise you against every bug, every race or a compromised user account. Keep backups. See [Limitations](#limitations) and [SECURITY.md](SECURITY.md) for exactly what is and is not defended.

## What it will never touch

The protected-path denylist beats every other rule, including a plan that was edited and approved:

`.git` directories (and anything that contains a nested `.git`), `.ssh`, `.gnupg`, `.aws`, `.config`, `.kube`, `.azure`, `.docker`, keychains, `.env*` files, Documents, Desktop, Downloads, Pictures, Music, Movies, iCloud / Dropbox / OneDrive / Google Drive style sync folders, database data directories (`pgdata`, `PG_VERSION`, `ibdata1`, `mongod.lock`, ...), anything named like a secret or key material, and the home directory itself. It also never follows symlinks, never crosses a file system boundary, never touches a Docker volume or a running container, and never removes a git worktree (worktrees are report-only).

## Install

`disk-janitor` is not published to a registry yet. Build from source (Node.js >= 22.12):

```sh
git clone <this repository> disk-janitor && cd disk-janitor
npm ci --ignore-scripts
npm run build
node dist/infrastructure/cli/bin.js --help      # or: npm link   ->   disk-janitor, disk-janitor-mcp
```

## How a human uses it

```sh
# 1. look (read-only). There is no default root: you must name one.
disk-janitor scan --root ~/projects --caches

# 2. write a plan. Nothing is changed. The plan lands in ~/.local/state/disk-janitor/plans/
disk-janitor plan --root ~/projects --caches
disk-janitor explain <plan id>

# 3. approve it, in a real terminal. `explain` printed the full digest; approve lists every
#    candidate and asks you to type that digest back (it is not shown on the approve screen)
disk-janitor approve <plan id>
#    or, best effort, answer a native OS dialog instead of the terminal:
disk-janitor approve <plan id> --approver dialog

# 4. apply: moves the candidates into quarantine (use the same --root/--caches flags as `plan`)
disk-janitor apply <plan id> --root ~/projects --caches

# 5. changed your mind?
disk-janitor restore <plan id>              # or: disk-janitor restore /path/to/node_modules

# 6. free the space for real, after the TTL (default 7 days). Human-only.
disk-janitor purge --dry-run      # prints the confirmation code
disk-janitor purge                # asks you to type that code
```

Other commands: `status` (state directory, quarantine, audit chain), `audit` (prints the JSONL audit log and verifies its chain), `doctor` (state-dir permissions, key file mode, same-device rename support, git / lsof / docker availability).

Flags: `--root <dir>` (repeatable), `--config <file>`, `--state-dir <dir>`, `--home <dir>`, `--caches`, `--docker-apply`, `--detectors a,b`, `--stale-days`, `--build-min-age-days`, `--cache-min-age-days`, `--min-size <bytes>`, `--out <file>`, `--minutes <n>` (approval validity, 15 by default, 60 at most), `--approver terminal|dialog`, `--ttl-days <n>`, `--dry-run`, `--json`, `--verbose`. Plans bind the configuration that made them: `apply` refuses a different configuration, so keep the flags (or a `--config` file) identical between `plan` and `apply`.

The state directory defaults to `$XDG_STATE_HOME/disk-janitor` or `~/.local/state/disk-janitor` (mode 0700; refused when it is a symlink, group- or world-writable, or inside a root).

### What the real terminal flow looks like

`approve` and `purge` read from a TTY. The sessions below were produced by the real binary in a container against a throwaway fake `$HOME`; the "terminal" is a pty created with `script(1)`, and the line typed is the full digest the human copied from `explain` (for purge, the code printed by `purge --dry-run`). The same pty trick is available to any process running as your user: see the next section.

## Approval: what the gate stops, and what it does not

**It stops:** accidental `apply`s, scripts and agent tool calls that have no terminal, CI jobs, and a plan someone edited after review (the digest changes, so no approval matches). **It does not stop** a process that runs as your OS user, has a shell and can allocate a pty (`script(1)`, `expect`, any pty library): that process can run `disk-janitor explain`, read the digest and type it into `disk-janitor approve`; and because the approval key is a file your user can read, it can also forge an approval or simply run `rm`. The [demo below](#a-real-session) approves exactly that way, with `script(1)` supplying the terminal.

Ways to get a real boundary:

1. **A different OS user (recommended).** Run `disk-janitor` and `disk-janitor-mcp` as a dedicated account (say `janitor`) that owns the state directory (0700) and has read/write access to the roots. Start the MCP server as that account (a restricted `sudoers` rule or a service) so the agent only talks to the server; approve with `sudo -u janitor disk-janitor approve <plan id>`. The key is unreadable to the agent's account. A root-owned approval key and `approvals/` directory with a small root-run approver is the same idea.
2. **`--approver dialog` (best effort).** The decision comes from a native confirmation dialog (`osascript` on macOS, `zenity` or `kdialog` on Linux) instead of the terminal. The command line is a fixed argument vector and the dialog text contains only the plan id, a digest prefix and numbers. A process that merely drives a pty cannot answer it; an agent that can click UI elements (macOS accessibility permission, a shared X11 session) can. It is unavailable on a headless host and never falls back to the terminal.

An HMAC approval needs the verifier to hold the key, so any account that can run `apply` can forge approvals; both options work by ensuring that account is not one the agent controls.

## A real session

Fake `$HOME` with a realistic mixed tree (stale and fresh projects, a dirty git repo, a symlinked `node_modules` aimed at a victim directory, a Python project, an npm cache, and tripwire files in `~/Documents` and `~/.ssh`). Run by [`scripts/demo.sh`](scripts/demo.sh) inside a container; the output is pasted unedited.

**Scan** (read-only):

```
$ disk-janitor scan --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
disk-janitor scan (read-only: nothing was changed)
roots: /tmp/dj-demo/home/projects
open-file check: NOT performed (lsof unavailable); make sure nothing is using these directories

      SIZE   AGE  DETECTOR      PATH
   5.0 MiB    90d  package-cache /tmp/dj-demo/home/.npm/_cacache
            why: npm cache at its default location, nothing inside modified for 90 days
            regenerate: npm re-downloads packages on demand
   4.0 MiB    90d  build-output  /tmp/dj-demo/home/projects/old-api/target
            why: build output target, nothing inside modified for 90 days; allowlisted name next to Cargo.toml (no git repository)
            regenerate: cargo build or mvn package
   3.0 MiB    90d  node-modules  /tmp/dj-demo/home/projects/webapp/node_modules
            why: project untouched for 90 days; package.json and package-lock.json present; git working tree clean
            regenerate: npm ci (in /tmp/dj-demo/home/projects/webapp)
   2.5 MiB    90d  node-modules  /tmp/dj-demo/home/projects/old-api/node_modules
            why: project untouched for 90 days; package.json and pnpm-lock.yaml present; no git repository
            regenerate: pnpm install --frozen-lockfile (in /tmp/dj-demo/home/projects/old-api)
   2.0 MiB    90d  build-output  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
            why: build output __pycache__, nothing inside modified for 90 days; allowlisted name next to mod.py (no git repository)
            regenerate: python recompiles bytecode on import
   2.0 MiB    90d  build-output  /tmp/dj-demo/home/projects/webapp/dist
            why: build output dist, nothing inside modified for 90 days; git-ignored and untracked
            regenerate: run the project's build (for example npm run build)

total reclaimable: 18.5 MiB in 6 candidates

report-only findings (never acted on):
  [docker] docker unavailable: the docker CLI was not found

skipped: 3 (use --verbose to list them with reasons)
```

**What was deliberately left alone** (`--verbose`):

```
skipped: 3 (listed below)
  [node-modules] /tmp/dj-demo/home/projects/wip/node_modules: git working tree has uncommitted or untracked changes
  [node-modules] /tmp/dj-demo/home/projects/trap/node_modules: node_modules is a symlink (never followed)
  [node-modules] /tmp/dj-demo/home/projects/fresh/node_modules: activity 0 days ago, minimum age is 30 days
```

**Plan** (nothing changed yet):

```
$ disk-janitor plan --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
plan:       plan-20261031T062828Z-582414af
digest:     37ccd3c298e7c3c850abaf1e0df46722229368d45fda0d821250f1f38e6802ce
created:    2026-10-31T06:28:28.990Z
roots:      /tmp/dj-demo/home/projects
candidates: 6 (6 directories to quarantine, 0 docker prune), 18.5 MiB
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist
plan file:  /tmp/dj-demo/state/plans/plan-20261031T062828Z-582414af.json

nothing was changed. Review it with:
  disk-janitor explain plan-20261031T062828Z-582414af
then a human approves it in a terminal:
  disk-janitor approve plan-20261031T062828Z-582414af
```

**An agent (no terminal) cannot approve, and apply without approval is refused:**

```
# an agent (no terminal) cannot approve:

$ disk-janitor approve plan-20261031T062828Z-582414af --state-dir /tmp/dj-demo/state
error: approve needs an interactive terminal on stdin and stdout; refusing in a non-interactive session

# and apply without approval is refused:

$ disk-janitor apply plan-20261031T062828Z-582414af --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
error: apply refused: no human approval exists for this plan digest. A human must run 'disk-janitor approve plan-20261031T062828Z-582414af' in a terminal
```

**A human approves at a terminal:**

```
# a human reads the digest in the explain output above and types it at a real terminal
# (the terminal here is a pty from script(1); any same-user process that can allocate a pty can do this too, see SECURITY.md):
$ disk-janitor approve plan-20261031T062828Z-582414af
37ccd3c298e7c3c850abaf1e0df46722229368d45fda0d821250f1f38e6802ce
plan:       plan-20261031T062828Z-582414af
created:    2026-10-31T06:28:28.990Z
roots:      /tmp/dj-demo/home/projects
candidates: 6 (6 directories to quarantine, 0 docker prune), 18.5 MiB

Approving lets 'apply' move the directories listed below into quarantine for 15 minutes.
Nothing is deleted by apply; directories stay restorable until a separate 'purge'.

Every candidate follows:
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist

[1G[0JType the full plan digest to approve. It is not shown on this screen: copy it from `disk-janitor explain <plan id>`. Anything else cancels: [141G37ccd3c298e7c3c850abaf1e0df46722229368d45fda0d821250f1f38e6802ce
approved until 2026-10-31T06:43:29.756Z. Run: disk-janitor apply plan-20261031T062828Z-582414af
```

**Apply** moves the candidates into quarantine:

```
$ disk-janitor apply plan-20261031T062828Z-582414af --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
applied plan-20261031T062828Z-582414af: 6 directories moved to quarantine
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist
quarantine: /tmp/dj-demo/state/quarantine/plan-20261031T062828Z-582414af
undo with:  disk-janitor restore plan-20261031T062828Z-582414af
```

**Restore one item, look at what a purge would delete, and purge as a human:**

```
# undo one item by path:

$ disk-janitor restore /tmp/dj-demo/home/projects/webapp/node_modules --state-dir /tmp/dj-demo/state
restored /tmp/dj-demo/home/projects/webapp/node_modules

# what would a purge delete? (TTL 0 only for this demo; the default is 7 days)

$ disk-janitor purge --state-dir /tmp/dj-demo/state --ttl-days 0 --dry-run
purge would permanently delete 5 quarantined item(s), 15.5 MiB:
     5.0 MiB  0d in quarantine  /tmp/dj-demo/home/.npm/_cacache  (plan-20261031T062828Z-582414af)
     4.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/target  (plan-20261031T062828Z-582414af)
     2.5 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/node_modules  (plan-20261031T062828Z-582414af)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__  (plan-20261031T062828Z-582414af)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/webapp/dist  (plan-20261031T062828Z-582414af)
(dry run: nothing deleted; confirmation code for a real purge: 9a4cde7a)

# purge needs a terminal too: without one it refuses

$ disk-janitor purge --state-dir /tmp/dj-demo/state --ttl-days 0
error: purge needs an interactive terminal on stdin and stdout; refusing in a non-interactive session

# a human types the confirmation code printed by the dry run, at a real terminal:
$ disk-janitor purge --ttl-days 0
9a4cde7a
purge would permanently delete 5 quarantined item(s), 15.5 MiB:
     5.0 MiB  0d in quarantine  /tmp/dj-demo/home/.npm/_cacache  (plan-20261031T062828Z-582414af)
     4.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/target  (plan-20261031T062828Z-582414af)
     2.5 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/node_modules  (plan-20261031T062828Z-582414af)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__  (plan-20261031T062828Z-582414af)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/webapp/dist  (plan-20261031T062828Z-582414af)
This cannot be undone.
[1G[0JType the confirmation code printed by `disk-janitor purge --dry-run` to permanently delete them, anything else cancels: [121G9a4cde7a
purged 5 item(s)
```

**The tripwires survive** (`~/Documents/taxes.txt`, `~/.ssh/id_demo`, the symlink victim, and the restored `webapp/node_modules`):

```
# tripwires (must all still be there):
tax records
-----fake key material-----
precious
node_modules
package-lock.json
package.json
src
```

## Detectors

Every detector is an explicit allowlist with unit tests; none deletes "big files" generically.

| Detector | Offers | Only when |
| --- | --- | --- |
| `node-modules` | `node_modules` of a project | `package.json` and a lockfile (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`) exist, so reinstalling is reproducible; the project is untouched for N days (default 30) by the mtime of `package.json`, the lockfile, the newest source file and `node_modules`; and, if it is a git repo, the working tree is clean (no uncommitted or untracked-non-ignored changes). `node_modules` that is a symlink is never offered. |
| `build-output` | `.next`, `dist`, `build`, `target`, `.turbo`, `.cache/vite`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `coverage` | the directory is git-ignored and holds no tracked files (`git check-ignore`), or the project has no git and the name is on the allowlist **and** a sibling manifest identifies the project type (`Cargo.toml` for `target`, `package.json` for `dist`, a `.py` file for `__pycache__`, ...). Nothing inside modified for 7 days (default). |
| `package-cache` (opt-in: `--caches`) | npm `_cacache`, pnpm store, yarn caches, pip cache, cargo registry cache, Homebrew downloads, Gradle caches | found at the documented default location below `--home` only, with no symlink in the path. |
| `docker` | report-only: parsed `docker system df`. With `--docker-apply`: build cache and dangling images | pruned only after approval, through two fixed argument lists (`builder prune --force`, `image prune --force`). Never volumes, never running containers, never `-a`. Irreversible (not quarantined). |
| `git-worktrees` | report-only: prunable worktrees | never removed by this tool; the report tells you to review and run `git worktree prune` yourself. |

git is run defensively inside your projects: with an isolated environment (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` set to `/dev/null`, no hooks, no attributes or excludes file, no fsmonitor), and a repository whose own config defines commands (clean filters, `core.fsmonitor`, `core.hooksPath`, textconv, merge drivers, includes, credential helpers...) is skipped. Your *global* gitignore is therefore not consulted: a directory ignored only there is not offered.

All candidates also pass shared checks: minimum size (default 1 MiB), minimum age, protected-path denylist, same file system as the root, no special files, no nested `.git`, no `.env*` / private-key / database-marker files inside, a depth and entry-count limit, no hard link shared with a file outside the candidate (so e.g. a pnpm store whose files are hard-linked into projects is refused), and no open file handles (best effort with `lsof`). At apply time every candidate is checked again, including that it still *is* a catalogue item (a `node_modules` next to a `package.json` and lockfile, one of the exact build-output paths next to a manifest or inside a git repository, or an exact package-cache location), so a hand-written plan cannot get an arbitrary directory quarantined.

## MCP server

`disk-janitor-mcp` is a stdio MCP server for MCP clients. **Roots come from the server's flags or config file, never from tool arguments**, so an agent cannot widen its own scope.

```json
{
  "mcpServers": {
    "disk-janitor": {
      "command": "node",
      "args": [
        "/path/to/disk-janitor/dist/infrastructure/mcp/bin.js",
        "--root", "/home/me/projects",
        "--caches"
      ]
    }
  }
}
```

| Tool | Effect |
| --- | --- |
| `scan` | read-only: candidates with size, age, why safe, how to regenerate |
| `plan` | plan-only: writes a plan file, changes nothing, returns plan id and digest |
| `explain_plan` | read-only: shows a stored plan and verifies its digest |
| `status` | read-only: roots, audit-chain integrity, quarantine count |
| `list_quarantine` | read-only: quarantined items and their status |
| `restore_preview` | read-only: whether a plan's items could be restored |
| `apply_plan` | moves candidates into quarantine **only if a valid, unexpired, single-use approval exists for exactly this plan digest**, created by the user with `disk-janitor approve`; re-validates every candidate (including that it is a catalogue item) first. If docker apply is enabled it also prunes docker build cache and dangling images, which is irreversible and not quarantined |

There is no approve tool and no purge tool, and the server's instructions tell the agent that the approval step is the user's decision and is not a security boundary against a same-user process. Every file-system string in a tool result, including errors and warnings, is wrapped in an `<untrusted-data>` frame with control and invisible characters escaped, so a hostile directory name cannot talk to the model.

## Configuration file

`--config <file>` takes strict JSON (unknown keys are rejected, at most 64 KiB); flags override it:

```json
{
  "roots": ["/home/me/projects"],
  "stateDir": "/home/me/.local/state/disk-janitor",
  "detectors": ["node-modules", "build-output", "git-worktrees", "docker"],
  "packageCaches": true,
  "dockerApply": false,
  "staleDays": 30,
  "buildMinAgeDays": 7,
  "cacheMinAgeDays": 7,
  "minSizeBytes": 1048576,
  "maxDepth": 8,
  "maxCandidates": 500,
  "maxEntriesPerCandidate": 500000
}
```

## Architecture

Domain-driven, with a dependency rule that a test enforces. See [docs/domain.md](docs/domain.md) for the ubiquitous language and the context map (Discovery, Planning, Approval, Disposal, Audit) and [docs/adr](docs/adr) for the decisions.

```
src/domain/          pure: entities, value objects, aggregates (Plan, Approval, Manifest, AuditChain, ApplyRun),
                     policies (protected paths, roots, human session), domain events. No IO, clock or randomness.
src/application/     use cases (discover, create plan, approve, apply, restore, purge) and the ports they need.
src/infrastructure/  adapters: node fs, git / lsof / docker CLIs, state files, lock, audit log, CLI, MCP server.
src/composition/     wires adapters into use cases; the convenient library API.
```

`test/architecture.test.ts` scans every import and fails when the domain imports anything but the domain, when the application imports anything but domain and application, when a driven adapter imports the composition root, or when pure layers touch the file system, process, clock or randomness. The checker has its own self-tests so it cannot pass vacuously.

## Tests and coverage

Tests are organized by layer. Counts are from a full run:

| Suite | Tests | What it checks |
| --- | ---: | --- |
| `test/architecture.test.ts` | 13 | the dependency rule (and the checker itself) |
| `test/domain` | 1021 | pure unit and property-style tests of invariants, state transitions and domain events (seeded generators) |
| `test/application` | 346 | use cases driven with in-memory fakes of every port; assertions on results, state and ordered events |
| `test/infrastructure` | 399 | contract suites: the same tests run against the in-memory fake and the real adapter in temp directories (file system, git, lsof, docker CLI, plan / approval / key / audit / quarantine stores, lock) |
| `test/integration` | 740 | real directories and real git repositories through the composition API: every detector, symlink / race / TOCTOU / path-traversal / cross-device / hard-link attacks, plan tampering, approval forgery, hostile names, CLI and MCP in-process |
| `test/e2e` | 16 | the real built binaries (`disk-janitor`, `disk-janitor-mcp` over stdio) |
| **total** | **2535** | |

A tripwire home directory (with `~/Documents`, `~/.ssh` and a decoy project) is created per run, `HOME` points at it for every test, and the suite fails in teardown if a single byte under it changed.

Coverage is measured with vitest's v8 provider (`npm run coverage`) over `src/`, excluding the two small `bin` entry points (the e2e tests run them, but in a child process the provider cannot see):

```
layer            lines  statements  branches  functions   target
domain            99.7%      99.7%     98.9%     100.0%   >= 95% met
application       99.1%      98.1%     95.0%      91.7%   >= 90% met
infrastructure    97.3%      94.2%     83.9%      92.7%   -
composition      100.0%      97.6%     90.0%      97.0%   -
overall           98.8%      97.5%     93.7%      96.4%   >= 85% met
```

Line coverage of the infrastructure layer varies between 97.1% and 97.3% from run to run (and between Node 22 and 24); the other numbers were identical on both. Targets (enforced by `vitest.config.ts` thresholds and `scripts/coverage-summary.mjs`): domain >= 95% lines, application >= 90%, overall >= 85%. The numbers above were identical on Node 22 and Node 24 in the final run (infrastructure line coverage moved by +-0.2 points between earlier runs). Least covered files, honestly: `application/inspection.ts` 92.3% (the rethrow of an unexpected `errno` from `lstat`), `infrastructure/process/command-runner.ts` 92.8% lines and 56.5% branches (the `execFile` error branches that need a real failing or timing-out process), `infrastructure/cli/cli.ts` 94.7% (`realIO`, the real-terminal adapter, which only runs inside the spawned binary where the provider cannot see it, and a few `doctor` failure branches), `application/discover.ts` 95.5%. Branch coverage of the infrastructure layer is the weakest number (83.9%): defensive `catch` branches around races and permission errors that cannot be provoked deterministically in a container. Coverage says what ran, not that the assertions are strong; the symlink / race / tamper suites assert exact outcomes (tree hashes unchanged, victim directories intact, exact error codes) rather than just exercising the code.

Run everything inside a throwaway container (nothing runs on your host):

```sh
sh scripts/test-in-container.sh            # npm ci, typecheck, all layers, coverage, build (IMAGE=node:24 for Node 24)
# or, in any Node 22/24 environment with git:
npm ci --ignore-scripts && npm run test:layers && npm run coverage
```

`npm run test:architecture | test:domain | test:application | test:infrastructure | test:integration | test:e2e` run a single layer.

## Limitations

- **Not a security boundary against a same-user process.** The approval gate (TTY, environment markers, a typed digest) can be satisfied by any process that runs as your user and can allocate a pty, and the approval key is readable by that user. Use a separate OS account or `--approver dialog` for a real boundary; see [Approval: what the gate stops](#approval-what-the-gate-stops-and-what-it-does-not) and [SECURITY.md](SECURITY.md).
- **Rename races cannot be eliminated.** Node.js has no directory-relative `rename`. A swap that wins the race between the last check and the rename is detected afterwards and undone, and a swap of a parent directory is caught by the same identity check, but the window exists.
- **The open-file check needs `lsof`** and only sees your own processes. `doctor` and `scan` say when it is off.
- **Candidates must be on the same file system as the state directory** (quarantine is a `rename`; there is no copy fallback). Otherwise they are refused.
- **Hard-linked stores are refused**: a pnpm store (or `node_modules`) whose files are hard-linked outside the candidate is not offered.
- **Docker prunes are irreversible** and not quarantined; they run against whichever daemon `DOCKER_HOST` / `DOCKER_CONTEXT` select, which the approval screen prints.
- **Space is freed on `purge`**, not on `apply`.
- The audit chain detects edits, deletions and reordering, not truncation of its tail.
- Windows is not supported.

### What was not verified here

All development and test runs happened on Linux (arm64, amd64 for the lockfile check) in containers. macOS-specific locations (`~/Library/Caches/...`, `~/Library/pnpm/store`, `/private/var/...` system paths, APFS block accounting) are covered by path-string tests only, not on a real macOS volume. `lsof` is not installed in the test container, so the open-file protection is tested through an injected command runner, not against real open files. Docker is tested through an injected command runner; no real daemon was used. A real second file system could not be mounted, so cross-device refusal is tested with an injected `lstat` and a fake that raises `EXDEV`.

## Dependency policy

Every npm package version, direct and transitive, was published on or before 2026-10-24T00:00:00Z; direct dependencies are pinned exactly; installs use `--ignore-scripts` (including CI). The core has no runtime dependencies beyond Node.js; the MCP server uses `@modelcontextprotocol/sdk` and `zod`. See [SECURITY.md](SECURITY.md).

## Secrets and hooks

Never commit `.env` files or credentials. Keep real values in a local, git-ignored `.env` and commit only a `.env.example` with placeholders. (This tool itself reads no secrets: its only key is the per-user approval key in the state directory, which is never inside a repository.)

Install [lefthook](https://github.com/evilmartians/lefthook) and run `lefthook install` once per clone. This enables two hooks (see `lefthook.yml`):

- `pre-commit` runs `sh scripts/secret-scan.sh --staged` and blocks a commit that stages a secret-like file or key.
- `pre-push` runs `sh scripts/secret-scan.sh --tree` and blocks a push if any tracked file contains one.

CI has a separate `secret-scan` job that runs the same scanner over the working tree (`--tree`) and over the added lines of every commit reachable from `HEAD` (`--history`). The scanner is a dependency-free shell script; findings print the file, line and rule name, never the secret. A finding that is a reviewed, harmless fixture can be allowed by adding a line `<path> <rule>   # reason` to `.secret-scan-allow` (one entry per path and rule, no wildcards), or by putting the marker `secret-scan: allow` on the offending line. `.gitignore` also lists the usual secret-bearing file names.

If a secret is ever committed, treat it as compromised: rotate or revoke it first, then remove it from git history.

## License

MIT, see [LICENSE](LICENSE).
