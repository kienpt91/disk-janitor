# 4. Human-only approval through a terminal and a keyed record

Status: accepted

## Decision
`approve` and `purge` require a TTY on stdin and stdout and no agent or non-interactive marker in the environment, show a summary and require typing back a prefix of the digest. Approval is a short-lived, single-use record: HMAC-SHA256 over (plan digest, expiry, nonce, purpose) with a per-user key (mode 0600). Spent nonces are recorded in the audit log. The MCP server exposes no approve and no purge tool.

## Consequences
Ordinary agent runs and accidents cannot approve. A same-user process with a shell can read the key; SECURITY.md states this limit plainly and recommends sandboxing agents. The domain only knows a `Signer` interface; the key never enters it.
