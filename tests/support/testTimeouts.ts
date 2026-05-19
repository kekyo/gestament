// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

/** True when tests run as a grouped platform-container artifact run. */
export const isGroupedTestRun =
  process.env.GESTAMENT_TEST_RESULTS_GROUP !== undefined &&
  process.env.GESTAMENT_TEST_RESULTS_GROUP.length > 0;

/** Vitest per-test timeout used by the repository test config. */
export const vitestTestTimeoutMs = isGroupedTestRun ? 900_000 : 20_000;

/** Default expect.poll timeout used by the repository test config. */
export const vitestPollTimeoutMs = isGroupedTestRun ? 180_000 : 1_000;

/** GTK4 fixture readiness timeout used by visual tests. */
export const gtk4FixtureTimeoutMs = isGroupedTestRun ? 240_000 : 90_000;

/** Missing element lookup timeout used by GTK4 visual tests. */
export const gtk4MissingLookupTimeoutMs = isGroupedTestRun ? 90_000 : 10_000;

/** Explicit per-test timeout used by GTK4 visual tests. */
export const gtk4VisualTestTimeoutMs = isGroupedTestRun ? 540_000 : 240_000;

/** Child environment file wait timeout for launcher-scoped Xvfb tests. */
export const xvfbLauncherChildEnvironmentTimeoutMs = isGroupedTestRun
  ? 30_000
  : 1_000;

/** Child environment file wait timeout for Xvfb pool tests. */
export const xvfbPoolChildEnvironmentTimeoutMs = isGroupedTestRun
  ? 30_000
  : 2_000;

/** Fixture application readiness timeout used by Xvfb pool tests. */
export const xvfbPoolFixtureTimeoutMs = isGroupedTestRun ? 180_000 : 3_000;

/** Outer script timeout for launcher-scoped Xvfb tests. */
export const xvfbLauncherScriptTimeoutMs = isGroupedTestRun ? 240_000 : 60_000;

/** Outer script timeout for Xvfb pool tests. */
export const xvfbPoolScriptTimeoutMs = isGroupedTestRun ? 540_000 : 120_000;
