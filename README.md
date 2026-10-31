# disk-janitor

**Reclaim disk space with coding agents in the loop, without ever giving them `rm -rf`.**

Agents and dev environments leave a lot of reclaimable junk behind: `node_modules` of stale projects, package-manager caches, build outputs, Docker build cache, toolchain caches. Letting an agent delete it with a shell command is dangerous: one bad path, one symlink, one race and a home directory is gone. `disk-janitor` makes unsafe deletion *structurally hard*:

- **Read-only by default, two phases.** `scan` only looks. `plan` writes a reviewable JSON plan bound to a SHA-256 digest. Nothing moves until a human approves that exact digest.
- **A human-only approval step the agent cannot perform.** `approve` needs a real terminal on stdin and stdout, refuses when an agent or non-interactive marker is in the environment, and requires typing back the plan digest prefix. The MCP server has **no approve tool and no purge tool**.
- **Quarantine, then purge, with undo.** `apply` only `rename`s directories into a quarantine on the same file system. `restore` is a faithful undo. `purge` (human-only) permanently deletes only quarantined items older than a TTL (7 days by default) that an authenticated manifest lists.
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

# 3. approve it, in a real terminal: you read the summary and type the digest prefix back
disk-janitor approve <plan id>

# 4. apply: moves the candidates into quarantine (use the same --root/--caches flags as `plan`)
disk-janitor apply <plan id> --root ~/projects --caches

# 5. changed your mind?
disk-janitor restore <plan id>              # or: disk-janitor restore /path/to/node_modules

# 6. free the space for real, after the TTL (default 7 days). Human-only.
disk-janitor purge --dry-run
disk-janitor purge
```

Other commands: `status` (state directory, quarantine, audit chain), `audit` (prints the JSONL audit log and verifies its chain), `doctor` (state-dir permissions, key file mode, same-device rename support, git / lsof / docker availability).

Flags: `--root <dir>` (repeatable), `--config <file>`, `--state-dir <dir>`, `--home <dir>`, `--caches`, `--docker-apply`, `--detectors a,b`, `--stale-days`, `--build-min-age-days`, `--cache-min-age-days`, `--min-size <bytes>`, `--out <file>`, `--minutes <n>` (approval validity, 15 by default, 60 at most), `--ttl-days <n>`, `--dry-run`, `--json`, `--verbose`. Plans bind the configuration that made them: `apply` refuses a different configuration, so keep the flags (or a `--config` file) identical between `plan` and `apply`.

The state directory defaults to `$XDG_STATE_HOME/disk-janitor` or `~/.local/state/disk-janitor` (mode 0700; refused when it is a symlink, group- or world-writable, or inside a root).

### What the real terminal flow looks like

`approve` and `purge` read from a TTY. The sessions below were produced by the real binary in a container against a throwaway fake `$HOME`; the "terminal" is a pty created with `script(1)`, and the line typed by the human is the digest prefix shown in the prompt.

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
# what was deliberately left alone, and why:
$ disk-janitor scan --verbose ...
skipped: 3 (listed below)
  [node-modules] /tmp/dj-demo/home/projects/wip/node_modules: git working tree has uncommitted or untracked changes
  [node-modules] /tmp/dj-demo/home/projects/trap/node_modules: node_modules is a symlink (never followed)
  [node-modules] /tmp/dj-demo/home/projects/fresh/node_modules: activity 0 days ago, minimum age is 30 days
```

**Plan** (nothing changed yet):

```
$ disk-janitor plan --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
plan:       plan-20261031T053102Z-5b70071d
digest:     d1e9b49f4c39fb3c2821d85c25e431a4e3a70a15e1a4be643dafc851636f02be
created:    2026-10-31T05:31:02.996Z
roots:      /tmp/dj-demo/home/projects
candidates: 6 (6 directories to quarantine, 0 docker prune), 18.5 MiB
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist
plan file:  /tmp/dj-demo/state/plans/plan-20261031T053102Z-5b70071d.json

nothing was changed. Review it with:
  disk-janitor explain plan-20261031T053102Z-5b70071d
then a human approves it in a terminal:
  disk-janitor approve plan-20261031T053102Z-5b70071d
```

**An agent (no terminal) cannot approve, and apply without approval is refused:**

```
# an agent (no terminal) cannot approve:

$ disk-janitor approve plan-20261031T053102Z-5b70071d --state-dir /tmp/dj-demo/state
error: approve needs an interactive terminal on stdin and stdout; refusing in a non-interactive session

# and apply without approval is refused:

$ disk-janitor apply plan-20261031T053102Z-5b70071d --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
error: apply refused: no human approval exists for this plan digest. A human must run 'disk-janitor approve plan-20261031T053102Z-5b70071d' in a terminal
```

**A human approves at a terminal:**

```
# a human types the digest prefix at a real terminal (pty provided by script(1)):
$ disk-janitor approve plan-20261031T053102Z-5b70071d
d1e9b49f
plan:       plan-20261031T053102Z-5b70071d
digest:     d1e9b49f4c39fb3c2821d85c25e431a4e3a70a15e1a4be643dafc851636f02be
created:    2026-10-31T05:31:02.996Z
roots:      /tmp/dj-demo/home/projects
candidates: 6 (6 directories to quarantine, 0 docker prune), 18.5 MiB
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist

Approving lets 'apply' move these directories into quarantine for 15 minutes.
Nothing is deleted by apply; items stay restorable until a separate 'purge'.
[1G[0JType d1e9b49f to approve this plan (first 8 characters of its digest), anything else cancels: [95Gd1e9b49f
approved until 2026-10-31T05:46:03.536Z. Run: disk-janitor apply plan-20261031T053102Z-5b70071d
```

**Apply** moves the candidates into quarantine:

```
$ disk-janitor apply plan-20261031T053102Z-5b70071d --root /tmp/dj-demo/home/projects --home /tmp/dj-demo/home --caches --state-dir /tmp/dj-demo/state
applied plan-20261031T053102Z-5b70071d: 6 directories moved to quarantine
     5.0 MiB  /tmp/dj-demo/home/.npm/_cacache
     4.0 MiB  /tmp/dj-demo/home/projects/old-api/target
     3.0 MiB  /tmp/dj-demo/home/projects/webapp/node_modules
     2.5 MiB  /tmp/dj-demo/home/projects/old-api/node_modules
     2.0 MiB  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__
     2.0 MiB  /tmp/dj-demo/home/projects/webapp/dist
quarantine: /tmp/dj-demo/state/quarantine/plan-20261031T053102Z-5b70071d
undo with:  disk-janitor restore plan-20261031T053102Z-5b70071d
```

**Restore one item, look at what a purge would delete, and purge as a human:**

```
# undo one item by path:

$ disk-janitor restore /tmp/dj-demo/home/projects/webapp/node_modules --state-dir /tmp/dj-demo/state
restored /tmp/dj-demo/home/projects/webapp/node_modules

# what would a purge delete? (TTL 0 only for this demo; the default is 7 days)

$ disk-janitor purge --state-dir /tmp/dj-demo/state --ttl-days 0 --dry-run
purge would permanently delete 5 quarantined item(s), 15.5 MiB:
     5.0 MiB  0d in quarantine  /tmp/dj-demo/home/.npm/_cacache  (plan-20261031T053102Z-5b70071d)
     4.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/target  (plan-20261031T053102Z-5b70071d)
     2.5 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/node_modules  (plan-20261031T053102Z-5b70071d)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__  (plan-20261031T053102Z-5b70071d)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/webapp/dist  (plan-20261031T053102Z-5b70071d)
(dry run: nothing deleted; confirmation code for a real purge: 45bf18f8)

# purge is human-only as well: without a terminal it refuses

$ disk-janitor purge --state-dir /tmp/dj-demo/state --ttl-days 0
error: purge needs an interactive terminal on stdin and stdout; refusing in a non-interactive session

# a human types the confirmation code at a real terminal:
$ disk-janitor purge --ttl-days 0
45bf18f8
purge would permanently delete 5 quarantined item(s), 15.5 MiB:
     5.0 MiB  0d in quarantine  /tmp/dj-demo/home/.npm/_cacache  (plan-20261031T053102Z-5b70071d)
     4.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/target  (plan-20261031T053102Z-5b70071d)
     2.5 MiB  0d in quarantine  /tmp/dj-demo/home/projects/old-api/node_modules  (plan-20261031T053102Z-5b70071d)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/pylib/pkg/__pycache__  (plan-20261031T053102Z-5b70071d)
     2.0 MiB  0d in quarantine  /tmp/dj-demo/home/projects/webapp/dist  (plan-20261031T053102Z-5b70071d)
This cannot be undone.
[1G[0JType 45bf18f8 to permanently delete them, anything else cancels: [66G45bf18f8
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

All candidates also pass shared checks: minimum size (default 1 MiB), minimum age, protected-path denylist, same file system as the root, no special files, no nested `.git`, no `.env*` / private-key / database-marker files inside, a depth and entry-count limit, no hard link shared with a file outside the candidate (so e.g. a pnpm store whose files are hard-linked into projects is refused), and no open file handles (best effort with `lsof`).

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
| `apply_plan` | moves candidates into quarantine, **only if a human already approved exactly this plan digest** with `disk-janitor approve` in a terminal within the validity window; approvals are single-use |

There is no approve tool and no purge tool. Every path in a tool result is wrapped in an `<untrusted-data>` frame with control characters escaped, so a hostile directory name cannot talk to the model.

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
| `test/domain` | 881 | pure unit and property-style tests of invariants, state transitions and domain events (seeded generators) |
| `test/application` | 295 | use cases driven with in-memory fakes of every port; assertions on results, state and ordered events |
| `test/infrastructure` | 322 | contract suites: the same tests run against the in-memory fake and the real adapter in temp directories (file system, git, lsof, docker CLI, plan / approval / key / audit / quarantine stores, lock) |
| `test/integration` | 718 | real directories and real git repositories through the composition API: every detector, symlink / race / TOCTOU / path-traversal / cross-device / hard-link attacks, plan tampering, approval forgery, hostile names, CLI and MCP in-process |
| `test/e2e` | 16 | the real built binaries (`disk-janitor`, `disk-janitor-mcp` over stdio) |
| **total** | **2245** | |

A tripwire home directory (with `~/Documents`, `~/.ssh` and a decoy project) is created per run, `HOME` points at it for every test, and the suite fails in teardown if a single byte under it changed.

Coverage is measured with vitest's v8 provider (`npm run coverage`) over `src/`, excluding the two small `bin` entry points (the e2e tests run them, but in a child process the provider cannot see):

```
layer            lines  statements  branches  functions   target
domain            99.6%      99.6%     98.8%     100.0%   >= 95% met
application       99.0%      98.6%     95.6%      96.7%   >= 90% met
infrastructure    97.1%      94.0%     83.5%      92.4%   -
composition      100.0%      97.6%     90.0%      97.0%   -
overall           98.7%      97.6%     93.9%      97.0%   >= 85% met
```

Targets (enforced by `vitest.config.ts` thresholds and `scripts/coverage-summary.mjs`): domain >= 95% lines, application >= 90%, overall >= 85%. Least covered files, honestly: `application/inspection.ts` 92.3% (the rethrow of an unexpected `errno` from `lstat`), `infrastructure/process/command-runner.ts` 92.9% lines and 56.5% branches (the `execFile` error branches that need a real failing or timing-out process), `infrastructure/cli/cli.ts` 94.6% (`realIO`, the real-terminal adapter, which only runs inside the spawned binary where the provider cannot see it, and a few `doctor` failure branches). Branch coverage of the infrastructure layer is the weakest number (83.5%): defensive `catch` branches around races and permission errors that cannot be provoked deterministically in a container. Coverage says what ran, not that the assertions are strong; the symlink / race / tamper suites assert exact outcomes (tree hashes unchanged, victim directories intact, exact error codes) rather than just exercising the code.

Run everything inside a throwaway container (nothing runs on your host):

```sh
sh scripts/test-in-container.sh            # npm ci, typecheck, all layers, coverage, build (IMAGE=node:24 for Node 24)
# or, in any Node 22/24 environment with git:
npm ci --ignore-scripts && npm run test:layers && npm run coverage
```

`npm run test:architecture | test:domain | test:application | test:infrastructure | test:integration | test:e2e` run a single layer.

## Limitations

- **Not a security boundary against a same-user process.** The approval key is a file readable by your user; an agent that can run arbitrary commands as you can bypass the human gate (or just run `rm`). The TTY and environment checks stop accidents and ordinary agent runs. Run agents in a sandbox or another account if you need a hard boundary. Details in [SECURITY.md](SECURITY.md).
- **Rename races cannot be eliminated.** Node.js has no directory-relative `rename`. A swap that wins the race between the last check and the rename is detected afterwards and undone, and a swap of a parent directory is caught by the same identity check, but the window exists.
- **The open-file check needs `lsof`** and only sees your own processes. `doctor` and `scan` say when it is off.
- **Candidates must be on the same file system as the state directory** (quarantine is a `rename`; there is no copy fallback). Otherwise they are refused.
- **Hard-linked stores are refused**: a pnpm store (or `node_modules`) whose files are hard-linked outside the candidate is not offered.
- **Docker prunes are irreversible** and not quarantined.
- **Space is freed on `purge`**, not on `apply`.
- The audit chain detects edits, deletions and reordering, not truncation of its tail.
- Windows is not supported.

### What was not verified here

All development and test runs happened on Linux (arm64, amd64 for the lockfile check) in containers. macOS-specific locations (`~/Library/Caches/...`, `~/Library/pnpm/store`, `/private/var/...` system paths, APFS block accounting) are covered by path-string tests only, not on a real macOS volume. `lsof` is not installed in the test container, so the open-file protection is tested through an injected command runner, not against real open files. Docker is tested through an injected command runner; no real daemon was used. A real second file system could not be mounted, so cross-device refusal is tested with an injected `lstat` and a fake that raises `EXDEV`.

## Dependency policy

Every npm package version, direct and transitive, was published on or before 2026-10-24T00:00:00Z; direct dependencies are pinned exactly; installs use `--ignore-scripts` (including CI). The core has no runtime dependencies beyond Node.js; the MCP server uses `@modelcontextprotocol/sdk` and `zod`. See [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
