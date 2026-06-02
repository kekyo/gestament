// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

/** Platform test execution profile selected from the current test environment. */
export type TestExecutionProfile = 'local' | 'platformNative' | 'platformCross';

/** Timeout values used by repository integration tests. */
export interface TestTimeoutProfile {
  readonly fixtureWindowDiscoveryTimeoutMs: number;
  readonly missingLookupTimeoutMs: number;
  readonly visualE2eTestTimeoutMs: number;
  readonly vitestPollTimeoutMs: number;
  readonly vitestTestTimeoutMs: number;
  readonly xvfbLauncherChildEnvironmentTimeoutMs: number;
  readonly xvfbLauncherScriptTimeoutMs: number;
  readonly xvfbPoolChildEnvironmentTimeoutMs: number;
  readonly xvfbPoolFixtureTimeoutMs: number;
  readonly xvfbPoolScriptTimeoutMs: number;
}

/** True when tests run as a grouped platform-container artifact run. */
export const isGroupedTestRun =
  process.env.GESTAMENT_TEST_RESULTS_GROUP !== undefined &&
  process.env.GESTAMENT_TEST_RESULTS_GROUP.length > 0;

/** Resolves the timeout profile name from a test environment. */
export const resolveTestExecutionProfile = (
  env: NodeJS.ProcessEnv = process.env
): TestExecutionProfile => {
  const isGrouped =
    env.GESTAMENT_TEST_RESULTS_GROUP !== undefined &&
    env.GESTAMENT_TEST_RESULTS_GROUP.length > 0;
  if (!isGrouped) {
    return 'local';
  }

  const profile = env.GESTAMENT_TEST_EXECUTION_PROFILE;
  if (profile === undefined || profile.length === 0 || profile === 'native') {
    return 'platformNative';
  }
  if (profile === 'cross') {
    return 'platformCross';
  }

  throw new Error(`Unsupported GESTAMENT_TEST_EXECUTION_PROFILE: ${profile}`);
};

const timeoutProfiles: Record<TestExecutionProfile, TestTimeoutProfile> = {
  local: {
    fixtureWindowDiscoveryTimeoutMs: 90_000,
    missingLookupTimeoutMs: 10_000,
    visualE2eTestTimeoutMs: 240_000,
    vitestPollTimeoutMs: 1_000,
    vitestTestTimeoutMs: 20_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 1_000,
    xvfbLauncherScriptTimeoutMs: 60_000,
    xvfbPoolChildEnvironmentTimeoutMs: 2_000,
    xvfbPoolFixtureTimeoutMs: 3_000,
    xvfbPoolScriptTimeoutMs: 120_000,
  },
  platformNative: {
    fixtureWindowDiscoveryTimeoutMs: 240_000,
    missingLookupTimeoutMs: 10_000,
    visualE2eTestTimeoutMs: 540_000,
    vitestPollTimeoutMs: 180_000,
    vitestTestTimeoutMs: 900_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 30_000,
    xvfbLauncherScriptTimeoutMs: 240_000,
    xvfbPoolChildEnvironmentTimeoutMs: 30_000,
    xvfbPoolFixtureTimeoutMs: 180_000,
    xvfbPoolScriptTimeoutMs: 540_000,
  },
  platformCross: {
    fixtureWindowDiscoveryTimeoutMs: 900_000,
    missingLookupTimeoutMs: 90_000,
    visualE2eTestTimeoutMs: 1_800_000,
    vitestPollTimeoutMs: 600_000,
    vitestTestTimeoutMs: 1_800_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 120_000,
    xvfbLauncherScriptTimeoutMs: 1_200_000,
    xvfbPoolChildEnvironmentTimeoutMs: 120_000,
    xvfbPoolFixtureTimeoutMs: 600_000,
    xvfbPoolScriptTimeoutMs: 2_400_000,
  },
};

/** Resolves timeout values from a test environment. */
export const resolveTestTimeoutProfile = (
  env: NodeJS.ProcessEnv = process.env
): TestTimeoutProfile => timeoutProfiles[resolveTestExecutionProfile(env)];

/** Active test execution profile. */
export const testExecutionProfile = resolveTestExecutionProfile();

/** Active timeout values used by repository integration tests. */
export const testTimeoutProfile = resolveTestTimeoutProfile();

/** Vitest per-test timeout used by the repository test config. */
export const vitestTestTimeoutMs = testTimeoutProfile.vitestTestTimeoutMs;

/** Default expect.poll timeout used by the repository test config. */
export const vitestPollTimeoutMs = testTimeoutProfile.vitestPollTimeoutMs;

/** Fixture readiness and window discovery timeout used by visual tests. */
export const fixtureWindowDiscoveryTimeoutMs =
  testTimeoutProfile.fixtureWindowDiscoveryTimeoutMs;

/** Missing element lookup timeout used by visual tests. */
export const missingLookupTimeoutMs = testTimeoutProfile.missingLookupTimeoutMs;

/** Explicit per-test timeout used by visual and e2e tests. */
export const visualE2eTestTimeoutMs = testTimeoutProfile.visualE2eTestTimeoutMs;

/** Child environment file wait timeout for launcher-scoped Xvfb tests. */
export const xvfbLauncherChildEnvironmentTimeoutMs =
  testTimeoutProfile.xvfbLauncherChildEnvironmentTimeoutMs;

/** Child environment file wait timeout for Xvfb pool tests. */
export const xvfbPoolChildEnvironmentTimeoutMs =
  testTimeoutProfile.xvfbPoolChildEnvironmentTimeoutMs;

/** Fixture application readiness timeout used by Xvfb pool tests. */
export const xvfbPoolFixtureTimeoutMs =
  testTimeoutProfile.xvfbPoolFixtureTimeoutMs;

/** Outer script timeout for launcher-scoped Xvfb tests. */
export const xvfbLauncherScriptTimeoutMs =
  testTimeoutProfile.xvfbLauncherScriptTimeoutMs;

/** Outer script timeout for Xvfb pool tests. */
export const xvfbPoolScriptTimeoutMs =
  testTimeoutProfile.xvfbPoolScriptTimeoutMs;
