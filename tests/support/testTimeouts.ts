// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  defaultRuntimeTimeouts,
  runtimeTimeoutEnvironmentNames,
} from '../../src/runtimeTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

/** Platform test execution profile selected from the current test environment. */
export type TestExecutionProfile = 'local' | 'platformNative' | 'platformCross';

type RuntimeTimeoutEnvironmentName =
  (typeof runtimeTimeoutEnvironmentNames)[keyof typeof runtimeTimeoutEnvironmentNames];

/** Environment variables that tune gestament runtime infrastructure timeouts. */
export type RuntimeTimeoutEnvironment = Record<
  RuntimeTimeoutEnvironmentName,
  string
>;

/** Timeout values used by repository integration tests. */
export interface TestTimeoutProfile {
  readonly appOutputExitTimeoutMs: number;
  readonly cliScriptTimeoutMs: number;
  readonly fixtureWindowDiscoveryTimeoutMs: number;
  readonly launcherScriptTimeoutMs: number;
  readonly missingLookupTimeoutMs: number;
  readonly platformSmokeScriptTimeoutMs: number;
  readonly spawnTextExitTimeoutMs: number;
  readonly spawnTextForcedTimeoutMs: number;
  readonly visualE2eTestTimeoutMs: number;
  readonly vitestHookTimeoutMs: number;
  readonly vitestPollTimeoutMs: number;
  readonly vitestTeardownTimeoutMs: number;
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
    appOutputExitTimeoutMs: 5_000,
    cliScriptTimeoutMs: 20_000,
    fixtureWindowDiscoveryTimeoutMs: 90_000,
    launcherScriptTimeoutMs: 45_000,
    missingLookupTimeoutMs: 10_000,
    platformSmokeScriptTimeoutMs: 10_000,
    spawnTextExitTimeoutMs: 5_000,
    spawnTextForcedTimeoutMs: 50,
    visualE2eTestTimeoutMs: 240_000,
    vitestHookTimeoutMs: 20_000,
    vitestPollTimeoutMs: 1_000,
    vitestTeardownTimeoutMs: 20_000,
    vitestTestTimeoutMs: 20_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 1_000,
    xvfbLauncherScriptTimeoutMs: 60_000,
    xvfbPoolChildEnvironmentTimeoutMs: 2_000,
    xvfbPoolFixtureTimeoutMs: 3_000,
    xvfbPoolScriptTimeoutMs: 120_000,
  },
  platformNative: {
    appOutputExitTimeoutMs: 30_000,
    cliScriptTimeoutMs: 120_000,
    fixtureWindowDiscoveryTimeoutMs: 240_000,
    launcherScriptTimeoutMs: 240_000,
    missingLookupTimeoutMs: 10_000,
    platformSmokeScriptTimeoutMs: 60_000,
    spawnTextExitTimeoutMs: 30_000,
    spawnTextForcedTimeoutMs: 500,
    visualE2eTestTimeoutMs: 540_000,
    vitestHookTimeoutMs: 900_000,
    vitestPollTimeoutMs: 180_000,
    vitestTeardownTimeoutMs: 900_000,
    vitestTestTimeoutMs: 900_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 30_000,
    xvfbLauncherScriptTimeoutMs: 240_000,
    xvfbPoolChildEnvironmentTimeoutMs: 30_000,
    xvfbPoolFixtureTimeoutMs: 180_000,
    xvfbPoolScriptTimeoutMs: 540_000,
  },
  platformCross: {
    appOutputExitTimeoutMs: 120_000,
    cliScriptTimeoutMs: 300_000,
    fixtureWindowDiscoveryTimeoutMs: 900_000,
    launcherScriptTimeoutMs: 600_000,
    missingLookupTimeoutMs: 90_000,
    platformSmokeScriptTimeoutMs: 120_000,
    spawnTextExitTimeoutMs: 120_000,
    spawnTextForcedTimeoutMs: 5_000,
    visualE2eTestTimeoutMs: 1_800_000,
    vitestHookTimeoutMs: 1_800_000,
    vitestPollTimeoutMs: 600_000,
    vitestTeardownTimeoutMs: 1_800_000,
    vitestTestTimeoutMs: 1_800_000,
    xvfbLauncherChildEnvironmentTimeoutMs: 120_000,
    xvfbLauncherScriptTimeoutMs: 1_200_000,
    xvfbPoolChildEnvironmentTimeoutMs: 120_000,
    xvfbPoolFixtureTimeoutMs: 600_000,
    xvfbPoolScriptTimeoutMs: 2_400_000,
  },
};

const runtimeTimeoutEnvironments: Record<
  TestExecutionProfile,
  RuntimeTimeoutEnvironment
> = {
  local: {
    [runtimeTimeoutEnvironmentNames.appWaitTimeoutMs]: String(
      defaultRuntimeTimeouts.appWaitTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.appReleaseTimeoutMs]: String(
      defaultRuntimeTimeouts.appReleaseTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.atspiReadinessProbeTimeoutMs]: String(
      defaultRuntimeTimeouts.atspiReadinessProbeTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.atspiStateChangeTimeoutMs]: String(
      defaultRuntimeTimeouts.atspiStateChangeTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.displaySessionReleaseTimeoutMs]: String(
      defaultRuntimeTimeouts.displaySessionReleaseTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.displaySessionStartupTimeoutMs]: String(
      defaultRuntimeTimeouts.displaySessionStartupTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.trayHostReadyTimeoutMs]: String(
      defaultRuntimeTimeouts.trayHostReadyTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.windowActivationTimeoutMs]: String(
      defaultRuntimeTimeouts.windowActivationTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.windowGeometryTimeoutMs]: String(
      defaultRuntimeTimeouts.windowGeometryTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.xvfbPoolProbeTimeoutMs]: String(
      defaultRuntimeTimeouts.xvfbPoolProbeTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.xvfbSocketConnectTimeoutMs]: String(
      defaultRuntimeTimeouts.xvfbSocketConnectTimeoutMs
    ),
    [runtimeTimeoutEnvironmentNames.xvfbStartupTimeoutMs]: String(
      defaultRuntimeTimeouts.xvfbStartupTimeoutMs
    ),
  },
  platformNative: {
    GESTAMENT_APP_WAIT_TIMEOUT_MS: '240000',
    GESTAMENT_APP_RELEASE_TIMEOUT_MS: '30000',
    GESTAMENT_ATSPI_READINESS_PROBE_TIMEOUT_MS: '500',
    GESTAMENT_ATSPI_STATE_CHANGE_TIMEOUT_MS: '30000',
    GESTAMENT_DISPLAY_SESSION_RELEASE_TIMEOUT_MS: '30000',
    GESTAMENT_DISPLAY_SESSION_STARTUP_TIMEOUT_MS: '120000',
    GESTAMENT_TRAY_HOST_READY_TIMEOUT_MS: '120000',
    GESTAMENT_WINDOW_ACTIVATION_TIMEOUT_MS: '30000',
    GESTAMENT_WINDOW_GEOMETRY_TIMEOUT_MS: '30000',
    GESTAMENT_XVFB_POOL_PROBE_TIMEOUT_MS: '180000',
    GESTAMENT_XVFB_SOCKET_CONNECT_TIMEOUT_MS: '2000',
    GESTAMENT_XVFB_STARTUP_TIMEOUT_MS: '60000',
  },
  platformCross: {
    GESTAMENT_APP_WAIT_TIMEOUT_MS: '900000',
    GESTAMENT_APP_RELEASE_TIMEOUT_MS: '120000',
    GESTAMENT_ATSPI_READINESS_PROBE_TIMEOUT_MS: '5000',
    GESTAMENT_ATSPI_STATE_CHANGE_TIMEOUT_MS: '120000',
    GESTAMENT_DISPLAY_SESSION_RELEASE_TIMEOUT_MS: '120000',
    GESTAMENT_DISPLAY_SESSION_STARTUP_TIMEOUT_MS: '300000',
    GESTAMENT_TRAY_HOST_READY_TIMEOUT_MS: '300000',
    GESTAMENT_WINDOW_ACTIVATION_TIMEOUT_MS: '120000',
    GESTAMENT_WINDOW_GEOMETRY_TIMEOUT_MS: '120000',
    GESTAMENT_XVFB_POOL_PROBE_TIMEOUT_MS: '600000',
    GESTAMENT_XVFB_SOCKET_CONNECT_TIMEOUT_MS: '10000',
    GESTAMENT_XVFB_STARTUP_TIMEOUT_MS: '300000',
  },
};

/** Resolves timeout values from a test environment. */
export const resolveTestTimeoutProfile = (
  env: NodeJS.ProcessEnv = process.env
): TestTimeoutProfile => timeoutProfiles[resolveTestExecutionProfile(env)];

/** Resolves gestament runtime timeout environment variables from a test environment. */
export const resolveRuntimeTimeoutEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): RuntimeTimeoutEnvironment =>
  runtimeTimeoutEnvironments[resolveTestExecutionProfile(env)];

/** Active test execution profile. */
export const testExecutionProfile = resolveTestExecutionProfile();

/** Active timeout values used by repository integration tests. */
export const testTimeoutProfile = resolveTestTimeoutProfile();

/** Active gestament runtime timeout environment variables used by tests. */
export const runtimeTimeoutEnvironment = resolveRuntimeTimeoutEnvironment();

/** Child application output exit wait timeout used by launcher output tests. */
export const appOutputExitTimeoutMs = testTimeoutProfile.appOutputExitTimeoutMs;

/** Child process timeout used by CLI scaffold tests. */
export const cliScriptTimeoutMs = testTimeoutProfile.cliScriptTimeoutMs;

/** Vitest per-test timeout used by the repository test config. */
export const vitestTestTimeoutMs = testTimeoutProfile.vitestTestTimeoutMs;

/** Vitest hook timeout used by the repository test config. */
export const vitestHookTimeoutMs = testTimeoutProfile.vitestHookTimeoutMs;

/** Default expect.poll timeout used by the repository test config. */
export const vitestPollTimeoutMs = testTimeoutProfile.vitestPollTimeoutMs;

/** Vitest teardown timeout used by the repository test config. */
export const vitestTeardownTimeoutMs =
  testTimeoutProfile.vitestTeardownTimeoutMs;

/** Fixture readiness and window discovery timeout used by visual tests. */
export const fixtureWindowDiscoveryTimeoutMs =
  testTimeoutProfile.fixtureWindowDiscoveryTimeoutMs;

/** Child process timeout used by launcher behavior tests. */
export const launcherScriptTimeoutMs =
  testTimeoutProfile.launcherScriptTimeoutMs;

/** Missing element lookup timeout used by visual tests. */
export const missingLookupTimeoutMs = testTimeoutProfile.missingLookupTimeoutMs;

/** Child process timeout used by platform container smoke tests. */
export const platformSmokeScriptTimeoutMs =
  testTimeoutProfile.platformSmokeScriptTimeoutMs;

/** Child process timeout used when spawnText should observe a normal exit. */
export const spawnTextExitTimeoutMs = testTimeoutProfile.spawnTextExitTimeoutMs;

/** Child process timeout used when spawnText should force termination. */
export const spawnTextForcedTimeoutMs =
  testTimeoutProfile.spawnTextForcedTimeoutMs;

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
