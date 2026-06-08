// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { defineConfig } from 'vitest/config';

import { createTestArtifactsReporter } from './tests/support/artifactReporter';
import { initializeTestRunTimestamp } from './tests/support/testArtifacts';
import {
  vitestHookTimeoutMs,
  vitestPollTimeoutMs,
  vitestTeardownTimeoutMs,
  vitestTestTimeoutMs,
} from './tests/support/testTimeouts';

initializeTestRunTimestamp();

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    maxConcurrency: 24,
    expect: {
      poll: {
        timeout: vitestPollTimeoutMs,
      },
    },
    globals: true,
    hookTimeout: vitestHookTimeoutMs,
    reporters: ['default', createTestArtifactsReporter()],
    setupFiles: ['./tests/support/setupArtifacts.ts'],
    teardownTimeout: vitestTeardownTimeoutMs,
    testTimeout: vitestTestTimeoutMs,
  },
  esbuild: {
    target: 'node20',
  },
});
