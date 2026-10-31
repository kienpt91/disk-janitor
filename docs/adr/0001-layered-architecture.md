# 1. Layered architecture with a mechanically enforced dependency rule

Status: accepted

## Context
A cleanup tool is only trustworthy if the rules that decide what may be touched can be read, tested and reasoned about without a file system. Early versions mixed rules, IO and orchestration in single modules (for example apply, which validated, called `lstat`, hashed and renamed in one function), so the important rules could only be tested through real directories.

## Decision
Three layers plus a composition root:

- `domain/`: pure. Entities, value objects, aggregates, policies and domain events. Imports only other domain files and `node:path`; `node:crypto` is allowed only for `createHash` in one module. No file system, process, network, clock or randomness.
- `application/`: use cases and ports. Imports only domain and application. Time, ids, files, git, docker, stores and locks arrive through ports.
- `infrastructure/`: adapters. Driven adapters (file system, process, state files) implement ports and never import composition. The two driving adapters, `infrastructure/cli` and `infrastructure/mcp`, sit at the edge and call the composition API; they are the only infrastructure modules allowed to import it.
- `composition/`: wires adapters into use cases and exposes convenience functions.

`test/architecture.test.ts` scans every import and the use of forbidden tokens (`Date.now`, `new Date()`, `Math.random`, `process.`, `node:fs`...) and fails on violations. The checker has its own self-tests so it cannot silently pass.

## Consequences
Rules are unit-testable in microseconds and property-testable. Adapters can be swapped for in-memory fakes in application tests. Adding a dependency from an inner layer to an outer one fails CI.
