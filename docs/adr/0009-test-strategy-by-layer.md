# 9. Tests are organized by layer and coverage is measured

Status: accepted

## Decision
- `test/domain`: fast pure unit and property-style tests; every invariant has a failing-case test, every transition and every event is tested.
- `test/application`: use cases driven with in-memory fakes of all ports; assertions on results, resulting state and the exact ordered events.
- `test/infrastructure`: contract suites run against both the in-memory fake and the real adapter in temp directories.
- `test/integration`: scenario suites (real file systems, real git, scripted lsof and docker) through the composition API, including symlink/race/traversal attacks.
- `test/e2e`: the real binaries and the MCP server over stdio and in-memory transports.
- `test/architecture.test.ts`: the dependency rule.

Coverage uses vitest's v8 provider (`npm run coverage`) with targets domain >= 95%, application >= 90%, overall >= 85% lines; the README reports the real numbers and lists what is not covered.

## Consequences
Failures point at a layer. Tests that only echo mocks are not written; fakes exist to exercise real use case logic.
