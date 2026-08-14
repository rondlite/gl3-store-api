import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file runs against the same database and truncates between
    // tests, so files must not run concurrently -- otherwise one file's
    // truncate deletes rows another file is midway through using.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
