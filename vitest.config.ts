// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { defineConfig } from 'vitest/config';

import { createTestArtifactsReporter } from './tests/support/artifactReporter';
import { initializeTestRunTimestamp } from './tests/support/testArtifacts';

initializeTestRunTimestamp();

const isGroupedArtifactRun =
  process.env.GESTAMENT_TEST_RESULTS_GROUP !== undefined &&
  process.env.GESTAMENT_TEST_RESULTS_GROUP.length > 0;
const serializedGroupedArtifactArchitectures = new Set(['arm64', 'riscv64']);
const isSerializedGroupedArtifactRun =
  isGroupedArtifactRun &&
  serializedGroupedArtifactArchitectures.has(
    process.env.GESTAMENT_TEST_RESULTS_ARCH ?? ''
  );
const testTimeout = isGroupedArtifactRun ? 600_000 : 20_000;
const pollTimeout = isGroupedArtifactRun ? 90_000 : 1_000;

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: !isSerializedGroupedArtifactRun,
    expect: {
      poll: {
        timeout: pollTimeout,
      },
    },
    globals: true,
    poolOptions: {
      forks: {
        singleFork: isSerializedGroupedArtifactRun,
      },
    },
    reporters: ['default', createTestArtifactsReporter()],
    setupFiles: ['./tests/support/setupArtifacts.ts'],
    testTimeout,
  },
  esbuild: {
    target: 'node20',
  },
});
