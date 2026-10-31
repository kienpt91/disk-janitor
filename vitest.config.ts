import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/infrastructure/cli/bin.ts", "src/infrastructure/mcp/bin.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      // Targets from docs/adr/0009-test-strategy-by-layer.md; a run below them fails.
      thresholds: {
        lines: 85,
        "src/domain/**": { lines: 95 },
        "src/application/**": { lines: 90 },
      },
    },
  },
});
