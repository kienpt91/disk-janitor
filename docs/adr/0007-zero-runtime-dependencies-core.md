# 7. No runtime dependencies in the core

Status: accepted

## Decision
Domain, application and the CLI use only Node.js built-ins. The MCP server (infrastructure) uses `@modelcontextprotocol/sdk` and `zod`. Every dependency version, direct and transitive, was published before the cutoff recorded in SECURITY.md, installs use `--ignore-scripts`, and the core has a hand-written strict schema validator instead of a schema library.

## Consequences
A small supply-chain surface for a tool that moves files. The price is a little code (the validator) that is covered by its own tests.
