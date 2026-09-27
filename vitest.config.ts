import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // Points NANITES_HOME at a scratch dir and the health check's disk probe
    // at a real directory, so no test reads the developer's ~/.nanites or the
    // host's free space. See test/setup.ts.
    setupFiles: ["./test/setup.ts"],
  },
});
