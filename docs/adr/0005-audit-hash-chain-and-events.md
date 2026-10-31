# 5. Domain events are the audit log

Status: accepted

## Decision
Aggregates and use cases raise domain events (`plan-created`, `approval-issued`, `approval-consumed`, `apply-start`, `quarantine-done`, `restore-done`, `purge-done`, ...). An `EventPublisher` port delivers them; the infrastructure adapter appends them to a JSONL file as a SHA-256 hash chain. Apply verifies the chain first and refuses to run on a broken one; approval replay protection reads consumed nonces from it. Audit is written ahead of the action it describes, so a failing audit write stops the action.

## Consequences
The log reads in the domain's language and tests can assert exact event sequences without touching the log file. The chain detects edits, deletions and reordering but not tail truncation (the head hash can be anchored elsewhere).
