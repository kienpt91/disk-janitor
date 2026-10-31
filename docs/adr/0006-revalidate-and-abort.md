# 6. Re-validate everything at apply time and abort as a whole

Status: accepted

## Decision
Apply compares every candidate with the plan again (device and inode, type, no symlink in the parent chain, nothing modified since the plan, still inside the roots, not protected, same file system as the quarantine, no open file handles when `lsof` exists) and aborts before the first move if anything differs. During the move phase a failed rename rolls back the earlier moves. The comparison is a pure domain service fed with observed facts; gathering the facts is the application layer's job.

## Consequences
All-or-nothing behavior is testable without a file system and with one. Node has no directory-relative rename, so a swap in the last instant is detected after the rename rather than prevented (documented in SECURITY.md).
