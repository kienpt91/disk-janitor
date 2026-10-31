# Domain language and context map

This is the ubiquitous language of `disk-janitor`. The same words are used in the code (type, function and file names), in the tests (describe/it titles) and in the README. If a term here and a name in the code ever disagree, the code is wrong.

## Glossary

| Term | Meaning | Where it lives |
| --- | --- | --- |
| **Root** | A directory the user explicitly allows disk-janitor to look into (`--root`). There is no default. A root can never be `/`, the home directory, a parent of the home directory, a system directory or a protected location. | `domain/policy/roots.ts`, `application/validate-roots.ts` |
| **Home** | The user's home directory. Always protected; package caches are looked for below it. | `domain/model/config.ts` |
| **Detector** | An explicit, allowlist-based rule that recognises one kind of reclaimable junk: `node-modules`, `build-output`, `package-cache`, `docker`, `git-worktrees`. There is no generic "big files" detector. | `domain/discovery/`, `application/discover.ts` |
| **Candidate** | A thing a detector offers for cleanup. An **fs candidate** is a directory (canonical path, device and inode, size, mtimes, why it is safe, how to regenerate it); a **docker candidate** is a docker resource (`build-cache`, `dangling-images`) pruned through the docker CLI. | `domain/model/types.ts`, `domain/discovery/` |
| **Finding / skipped item** | A path a detector looked at and refused, with the reason. Skips are part of the answer: they show what was deliberately left alone. | `domain/discovery/eligibility.ts` |
| **Report item** | Information that is never acted on (docker usage, prunable git worktrees). | `domain/model/types.ts` |
| **Protected path** | A path the denylist always protects (`.git`, `.ssh`, `.gnupg`, `.aws`, `.config`, keychains, `.env*`, Documents, Desktop, sync folders, database data directories, secret-looking names). It beats every other rule. | `domain/policy/protected.ts` |
| **Scan** | The read-only discovery of candidates under the roots. | `application/discover.ts` |
| **Plan** | An immutable, digest-bound document listing the candidates a human may approve: id, creation time, configuration, candidates, reports and a SHA-256 **plan digest** over its canonical form. | `domain/plan/plan.ts` |
| **Plan digest** | The SHA-256 of the canonicalised plan without its own digest field. It is what a human approves and what an approval is bound to. | `domain/plan/plan.ts` |
| **Config digest** | SHA-256 of the canonical configuration (roots, thresholds, detectors) a plan was made with. Apply refuses a different configuration. | `domain/model/config.ts` |
| **Human session** | An interactive terminal on stdin and stdout with no agent or non-interactive marker in the environment. Approval and purge require one. | `domain/policy/human.ts` |
| **Approval** | A short-lived (15 minutes by default, 60 at most), single-use authorization to apply exactly one plan: a keyed MAC over the plan digest, expiry and a nonce. Only a human session can issue it. | `domain/approval/approval.ts`, `application/approvals.ts` |
| **Apply** | Re-validating every fs candidate against the plan and moving it into quarantine with `rename`; docker candidates are pruned afterwards. It never unlinks. If anything changed since the plan, the whole apply aborts before the first move. | `application/apply-plan.ts`, `domain/apply/` |
| **Revalidation** | The apply-time comparison of what the plan recorded with what is on disk now: same device and inode, still a real directory, no symlink in the parent chain, nothing modified, still inside the roots, not protected, same file system as the quarantine, no open files. | `domain/apply/revalidation.ts` |
| **Quarantine** | `<state>/quarantine/<planId>/`: where applied candidates wait, on the same file system, until they are restored or purged. | `domain/quarantine/`, `infrastructure/state/quarantine-store.ts` |
| **Manifest** | The authenticated record of a plan's quarantine: one **entry** per moved candidate (original path, identity, size, status). Status moves `pending → quarantined → restored` or `quarantined → purged`. | `domain/quarantine/manifest.ts` |
| **Restore** | The faithful undo: rename a quarantined entry back to its original path. It refuses to overwrite anything. | `application/restore.ts` |
| **Purge** | Permanent deletion of quarantined entries older than the TTL (7 days by default). Only entries listed in an authenticated manifest; human session and typed confirmation required. | `application/purge.ts` |
| **Audit log / chain** | The append-only, hash-chained JSONL record of every domain event. | `domain/audit/chain.ts`, `infrastructure/state/audit-log.ts` |
| **Domain event** | A fact that happened (`plan-created`, `approval-issued`, `approval-consumed`, `apply-start`, `quarantine-done`, `restore-done`, `purge-done`, ...). Events are the audit log's vocabulary. | `domain/events.ts` |
| **State directory** | `~/.local/state/disk-janitor` (or `$XDG_STATE_HOME`): plans, approvals, quarantine, the key file and the audit log. Mode 0700, never a symlink, never inside a root. | `infrastructure/state/state-dir.ts` |
| **Port** | An interface the application layer needs from the outside world (file system, git, clock, stores, lock...). | `application/ports/` |
| **Adapter** | An implementation of a port or an entry point (node file system, git CLI, lsof, docker CLI, CLI, MCP). | `infrastructure/` |

## Bounded contexts

```
                       +--------------------+
   roots, thresholds   |     Discovery      |  Detectors, eligibility rules, tree analysis
  ------------------>  | (Scan -> Candidates)|  ports: FileSystem, Git, OpenFiles, Docker, Clock
                       +---------+----------+
                                 | candidates, reports
                                 v
                       +--------------------+        +----------------------+
                       |      Planning      |        |      Approval        |
                       | (Plan, Config,     | digest | (Approval, Human     |
                       |  digests)          +------->|  session, Signer)    |
                       +---------+----------+        +----------+-----------+
                                 | plan                         | approval for digest
                                 v                              v
                       +-----------------------------------------------+
                       |                  Disposal                     |
                       | Apply (revalidation) -> Quarantine (Manifest) |
                       | -> Restore | Purge                            |
                       +-----------------------+-----------------------+
                                               | domain events
                                               v
                       +-----------------------------------------------+
                       |                    Audit                      |
                       |  hash-chained log of every domain event       |
                       +-----------------------------------------------+

   Shared kernel: protected paths, path containment, output escaping,
   canonical JSON and hashing, strict schemas, domain events.
```

Relationships:

- **Discovery -> Planning**: customer/supplier. Discovery produces candidates and reports; Planning wraps them in a Plan aggregate and enforces the plan invariants (canonical, unique, non-nested, inside a root, not protected).
- **Planning -> Approval**: the plan digest is the published language between them. An approval is meaningful only for the digest it was issued for.
- **Approval -> Disposal**: conformist. Apply accepts exactly the approval model (verify, then consume once) and adds no policy of its own.
- **Disposal -> Audit** (and every context -> Audit): open host service. Contexts publish domain events through the `EventPublisher` port; the audit log appends them to the hash chain. Apply also reads the log to refuse replayed approvals and to refuse running on a broken chain.
- **Shared kernel**: the protected-path denylist, path helpers, escaping and canonicalisation are shared by all contexts and have the strictest test coverage.
- **Interfaces**: the CLI and the MCP server are adapters over the same use cases. The MCP server has no approve tool and no purge tool by construction: those use cases are only reachable from the CLI, behind a human session.

## Layers

```
 composition  -> may use everything (wires adapters into use cases)
 infrastructure (adapters: fs, git, lsof, docker, state files, CLI, MCP)
      |  implements ports of
      v
 application (use cases; ports; no IO, no clock, no randomness)
      |  orchestrates
      v
 domain (entities, value objects, aggregates, policies, events; pure)
```

The dependency rule (domain imports only domain; application imports only domain and application; infrastructure never imports composition) is enforced by `test/architecture.test.ts`, which scans every import and also forbids IO, clock, randomness and process access in the pure layers.
