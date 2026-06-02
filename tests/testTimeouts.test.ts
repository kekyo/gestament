// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import {
  resolveTestExecutionProfile,
  resolveTestTimeoutProfile,
} from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const env = (
  values: Record<string, string | undefined>
): NodeJS.ProcessEnv => ({
  ...values,
});

describe('test timeout profiles', () => {
  it('uses the local profile outside grouped platform runs', () => {
    const testEnv = env({
      GESTAMENT_TEST_EXECUTION_PROFILE: 'cross',
    });

    expect(resolveTestExecutionProfile(testEnv)).toBe('local');
    expect(resolveTestTimeoutProfile(testEnv)).toMatchObject({
      fixtureWindowDiscoveryTimeoutMs: 90_000,
      missingLookupTimeoutMs: 10_000,
      visualE2eTestTimeoutMs: 240_000,
      vitestPollTimeoutMs: 1_000,
      vitestTestTimeoutMs: 20_000,
      xvfbLauncherScriptTimeoutMs: 60_000,
      xvfbPoolScriptTimeoutMs: 120_000,
    });
  });

  it('uses the platform native profile for grouped native runs', () => {
    const testEnv = env({
      GESTAMENT_TEST_EXECUTION_PROFILE: 'native',
      GESTAMENT_TEST_RESULTS_GROUP: 'platform-gtk3',
    });

    expect(resolveTestExecutionProfile(testEnv)).toBe('platformNative');
    expect(resolveTestTimeoutProfile(testEnv)).toMatchObject({
      fixtureWindowDiscoveryTimeoutMs: 240_000,
      missingLookupTimeoutMs: 10_000,
      visualE2eTestTimeoutMs: 540_000,
      vitestPollTimeoutMs: 180_000,
      vitestTestTimeoutMs: 900_000,
      xvfbLauncherScriptTimeoutMs: 240_000,
      xvfbPoolScriptTimeoutMs: 540_000,
    });
  });

  it('uses the platform cross profile for grouped cross runs', () => {
    const testEnv = env({
      GESTAMENT_TEST_EXECUTION_PROFILE: 'cross',
      GESTAMENT_TEST_RESULTS_GROUP: 'platform-gtk4',
    });

    expect(resolveTestExecutionProfile(testEnv)).toBe('platformCross');
    expect(resolveTestTimeoutProfile(testEnv)).toMatchObject({
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
    });
  });

  it('rejects unsupported grouped execution profiles', () => {
    const testEnv = env({
      GESTAMENT_TEST_EXECUTION_PROFILE: 'serialized',
      GESTAMENT_TEST_RESULTS_GROUP: 'platform-gtk3',
    });

    expect(() => resolveTestExecutionProfile(testEnv)).toThrow(
      'Unsupported GESTAMENT_TEST_EXECUTION_PROFILE: serialized'
    );
  });
});
