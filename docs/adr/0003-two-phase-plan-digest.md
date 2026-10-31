# 3. Two phases: scan, then a digest-bound plan

Status: accepted

## Decision
`scan` only reads. `plan` writes an immutable document whose SHA-256 digest covers its canonical JSON (candidates with canonical path, device, inode, size, mtime, detector and regeneration hint; the configuration digest; the creation time). Approval and apply refer to the digest, never to a path list that could be edited. Apply refuses a plan whose configuration differs from the active one and a plan older than 24 hours.

## Consequences
Tampering with a plan file changes its digest and invalidates any approval. The digest is not a secret: re-computing it after an edit yields a different digest that no human approved.
