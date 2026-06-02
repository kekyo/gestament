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

const groupedEnv = (
  executionProfile: string | undefined
): NodeJS.ProcessEnv => ({
  GESTAMENT_TEST_RESULTS_GROUP: 'platform-gtk3',
  GESTAMENT_TEST_EXECUTION_PROFILE: executionProfile,
});

describe.concurrent('test timeout profiles', () => {
  it('uses local timeouts when no grouped result run is active', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(resolveTestExecutionProfile(env)).toBe('local');
    expect(resolveTestTimeoutProfile(env)).toMatchObject({
      appOutputExitTimeoutMs: 5_000,
      buildPackageAllScriptTimeoutMs: 10_000,
      buildPackageScriptTimeoutMs: 60_000,
      cliScriptTimeoutMs: 20_000,
      headerCompileScriptTimeoutMs: 20_000,
      launcherScriptTimeoutMs: 45_000,
      packageConfigCommandTimeoutMs: 60_000,
      platformSmokeScriptTimeoutMs: 10_000,
      vitestHookTimeoutMs: 20_000,
      vitestTeardownTimeoutMs: 20_000,
    });
  });

  it('uses native platform timeouts for grouped native runs', () => {
    const env = groupedEnv(undefined);

    expect(resolveTestExecutionProfile(env)).toBe('platformNative');
    expect(resolveTestTimeoutProfile(env)).toMatchObject({
      appOutputExitTimeoutMs: 30_000,
      buildPackageAllScriptTimeoutMs: 60_000,
      buildPackageScriptTimeoutMs: 240_000,
      cliScriptTimeoutMs: 120_000,
      headerCompileScriptTimeoutMs: 120_000,
      launcherScriptTimeoutMs: 240_000,
      packageConfigCommandTimeoutMs: 120_000,
      platformSmokeScriptTimeoutMs: 60_000,
      vitestHookTimeoutMs: 900_000,
      vitestTeardownTimeoutMs: 900_000,
    });
  });

  it('uses cross platform timeouts when grouped runs opt in', () => {
    const env = groupedEnv('cross');

    expect(resolveTestExecutionProfile(env)).toBe('platformCross');
    expect(resolveTestTimeoutProfile(env)).toMatchObject({
      appOutputExitTimeoutMs: 120_000,
      buildPackageAllScriptTimeoutMs: 120_000,
      buildPackageScriptTimeoutMs: 1_200_000,
      cliScriptTimeoutMs: 300_000,
      headerCompileScriptTimeoutMs: 300_000,
      launcherScriptTimeoutMs: 600_000,
      packageConfigCommandTimeoutMs: 300_000,
      platformSmokeScriptTimeoutMs: 120_000,
      vitestHookTimeoutMs: 1_800_000,
      vitestTeardownTimeoutMs: 1_800_000,
    });
  });
});
