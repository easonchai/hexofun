import { defineConfig } from "vitest/config";

// The fork suite only. `tests/run-local.sh` never loads this config, and its
// default include pattern does not match `*.fork.ts`.
export default defineConfig({
  test: {
    include: ["tests/fork/**/*.fork.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
