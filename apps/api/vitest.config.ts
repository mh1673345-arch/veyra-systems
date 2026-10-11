import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Every file shares the one veyra_test database, and the notification queue
    // in it is global: the in-process processor started by one file will
    // legitimately deliver another file's pending rows. On PostgreSQL (true
    // concurrent writers, unlike SQLite's file lock) running files in parallel
    // made those cross-file effects — and bcrypt CPU contention past the test
    // timeouts — show up as flaky failures. Files run one at a time; tests
    // within a file are already sequential.
    fileParallelism: false,
    // The suite uses real bcrypt (cost 12, ~0.3-0.6s per hash) against a real
    // PostgreSQL. Several auth tests sign in three or four times, which put them
    // at 4-5s under a full run — right on vitest's 5s default, so they flaked.
    // A timeout is a hang detector, not a performance assertion.
    testTimeout: 20_000,
    // Fixtures hash passwords in beforeAll/beforeEach too, and vitest's hook
    // timeout is a separate 10s default: in a full serial run that is what
    // times out first, on a machine that is simply busy. Same reasoning as
    // testTimeout - a hang detector, not a performance assertion.
    hookTimeout: 20_000
  }
});
