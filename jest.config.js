/**
 * Jest configuration.
 *
 * ts-jest rather than compiling first and testing the JS in `dist/`: the stack
 * traces point at the TypeScript line you wrote, and there is no build step that
 * can silently go stale and leave you testing yesterday's code.
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",

  // "node", not "jsdom" — there is no DOM here, and jsdom adds seconds of
  // startup to every run for browser globals nothing uses. A slow suite is a
  // suite people stop running before committing.
  testEnvironment: "node",

  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],

  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      // Point ts-jest at the test-specific config; see tsconfig.test.json for
      // why the build config cannot be used directly.
      { tsconfig: "tsconfig.test.json" },
    ],
  },

  collectCoverageFrom: [
    "src/**/*.ts",
    // The demo script is a manual walkthrough with console.log output, not
    // library code. Counting it would make coverage look worse for the honest
    // reason that nobody unit-tests a demo — which trains you to ignore the
    // number. Coverage is only useful if it measures something you'd act on.
    "!src/index.ts",
  ],

  // Surface async work that outlives a test. This suite deliberately runs
  // overlapping check-ins to provoke race conditions, and a promise still pending
  // when a test ends is exactly the symptom of a lock that never released.
  // Without this, Jest exits quietly and the bug looks like a pass.
  detectOpenHandles: true,

  // Fail rather than hang. A deadlock — two mutexes acquired in opposite orders —
  // presents as a test that never finishes, and the default 5s is generous enough
  // here that anything slower is a genuine problem rather than a slow machine.
  testTimeout: 10000,
};
