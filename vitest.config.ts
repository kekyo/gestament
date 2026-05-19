// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { defineConfig } from 'vitest/config';

import { createTestArtifactsReporter } from './tests/support/artifactReporter';
import { initializeTestRunTimestamp } from './tests/support/testArtifacts';
import {
  isGroupedTestRun,
  vitestPollTimeoutMs,
  vitestTestTimeoutMs,
} from './tests/support/testTimeouts';

initializeTestRunTimestamp();

const serializedGroupedArtifactArchitectures = new Set([
  'arm64',
  'armv7l',
  'riscv64',
]);
const isSerializedGroupedArtifactRun =
  isGroupedTestRun &&
  serializedGroupedArtifactArchitectures.has(
    process.env.GESTAMENT_TEST_RESULTS_ARCH ?? ''
  );

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: !isSerializedGroupedArtifactRun,
    expect: {
      poll: {
        timeout: vitestPollTimeoutMs,
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
    testTimeout: vitestTestTimeoutMs,
  },
  esbuild: {
    target: 'node20',
  },
});
