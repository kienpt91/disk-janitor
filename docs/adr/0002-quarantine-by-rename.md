# 2. Quarantine by rename, never delete during apply

Status: accepted

## Context
The core risk of a cleanup tool is irreversible loss. Deleting directly makes every bug permanent.

## Decision
`apply` only calls `rename` to move a candidate into `<state>/quarantine/<planId>/items/NNNN`, on the same file system. If the quarantine is on another device the candidate is refused; there is no copy-and-delete fallback. An authenticated manifest records original paths and identities so `restore` is an exact undo. Permanent deletion is a separate human-only `purge`, limited to manifest entries older than a TTL (7 days by default).

## Consequences
Space is not freed until `purge`. A bug in candidate selection costs a restore, not data. A candidate on another file system cannot be cleaned (documented limitation). The tiny window between the last check and `rename` is closed afterwards: the moved item is compared with the plan and put back if it is not what was planned.
