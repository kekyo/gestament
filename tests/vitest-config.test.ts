// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { afterEach, describe, expect, it, vi } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const originalExecutionProfile = process.env.GESTAMENT_TEST_EXECUTION_PROFILE;
const originalResultsArch = process.env.GESTAMENT_TEST_RESULTS_ARCH;
const originalResultsGroup = process.env.GESTAMENT_TEST_RESULTS_GROUP;
const originalTimestamp = process.env.GESTAMENT_TEST_RUN_TIMESTAMP;

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const importVitestConfig = async (): Promise<{
  readonly test?: {
    readonly expect?: {
      readonly poll?: {
        readonly timeout?: number;
      };
    };
    readonly fileParallelism?: boolean;
    readonly poolOptions?: {
      readonly forks?: {
        readonly singleFork?: boolean;
      };
    };
    readonly testTimeout?: number;
  };
}> => {
  vi.resetModules();
  const module = await import('../vitest.config');
  return module.default;
};

afterEach(() => {
  restoreEnv('GESTAMENT_TEST_EXECUTION_PROFILE', originalExecutionProfile);
  restoreEnv('GESTAMENT_TEST_RESULTS_ARCH', originalResultsArch);
  restoreEnv('GESTAMENT_TEST_RESULTS_GROUP', originalResultsGroup);
  restoreEnv('GESTAMENT_TEST_RUN_TIMESTAMP', originalTimestamp);
  vi.resetModules();
});

describe('vitest.config.ts', () => {
  it('keeps file-level parallelism enabled for cross platform runs', async () => {
    process.env.GESTAMENT_TEST_EXECUTION_PROFILE = 'cross';
    process.env.GESTAMENT_TEST_RESULTS_ARCH = 'arm64';
    process.env.GESTAMENT_TEST_RESULTS_GROUP = 'platform-gtk3';
    delete process.env.GESTAMENT_TEST_RUN_TIMESTAMP;

    const config = await importVitestConfig();

    expect(config.test?.fileParallelism).toBe(true);
    expect(config.test?.poolOptions?.forks?.singleFork).toBeUndefined();
    expect(config.test?.testTimeout).toBe(1_800_000);
    expect(config.test?.expect?.poll?.timeout).toBe(600_000);
  });
});
