# 8. Docker pruning only through fixed argument lists

Status: accepted

## Decision
Docker is report-only by default. With `--docker-apply`, the only commands ever executed are `docker builder prune --force` and `docker image prune --force` (dangling images only), plus the read-only `system df` and `image ls --filter dangling=true`. Argument lists are constants in the domain catalog; no plan or user input reaches an argument vector. Volumes, running containers and `-a`/`--all` are never touched. The runner is an injected port, so tests use a fake CLI.

## Consequences
Docker prunes are irreversible and are not quarantined; the plan summary says so, and they run only after approval and after file-system candidates were moved.
