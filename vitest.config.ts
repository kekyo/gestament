// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { defineConfig } from 'vitest/config';

import { createTestArtifactsReporter } from './tests/support/artifactReporter';
import { initializeTestRunTimestamp } from './tests/support/testArtifacts';
import {
  vitestPollTimeoutMs,
  vitestTestTimeoutMs,
} from './tests/support/testTimeouts';

initializeTestRunTimestamp();

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: true,
    expect: {
      poll: {
        timeout: vitestPollTimeoutMs,
      },
    },
    globals: true,
    reporters: ['default', createTestArtifactsReporter()],
    setupFiles: ['./tests/support/setupArtifacts.ts'],
    testTimeout: vitestTestTimeoutMs,
  },
  esbuild: {
    target: 'node20',
  },
});
