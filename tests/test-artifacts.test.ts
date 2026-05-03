// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearCurrentTestArtifact,
  createTestArtifactDirectoryName,
  formatTestRunTimestamp,
  getTaskFullName,
  getTestArtifactConfig,
  resetTestArtifactConfigForTesting,
  saveCaptureArtifact,
  setCurrentTestArtifact,
} from './support/testArtifacts';
import type { GtkCapture } from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

const originalTimestamp = process.env.GESTAMENT_TEST_RUN_TIMESTAMP;
const originalArch = process.env.GESTAMENT_TEST_RESULTS_ARCH;
const originalRoot = process.env.GESTAMENT_TEST_RESULTS_ROOT;
const originalGroup = process.env.GESTAMENT_TEST_RESULTS_GROUP;
const tempRoots: string[] = [];

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const createTempRoot = async (): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-test-artifacts-'));
  tempRoots.push(tempRoot);
  return tempRoot;
};

afterEach(async () => {
  clearCurrentTestArtifact();
  restoreEnv('GESTAMENT_TEST_RUN_TIMESTAMP', originalTimestamp);
  restoreEnv('GESTAMENT_TEST_RESULTS_ARCH', originalArch);
  restoreEnv('GESTAMENT_TEST_RESULTS_ROOT', originalRoot);
  restoreEnv('GESTAMENT_TEST_RESULTS_GROUP', originalGroup);
  resetTestArtifactConfigForTesting();

  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, {
        force: true,
        recursive: true,
      })
    )
  );
});

/////////////////////////////////////////////////////////////////////////////////////////

describe('test artifact paths', () => {
  it('formats the test run timestamp with millisecond precision', () => {
    expect(formatTestRunTimestamp(new Date(2026, 4, 6, 1, 2, 3, 4))).toBe(
      '20260506_010203_004'
    );
  });

  it('builds a full test name from parent suites', () => {
    expect(
      getTaskFullName({
        id: 'task-id',
        name: 'captures the target',
        suite: {
          name: 'GTK visual tests',
          suite: {
            name: 'gtk3-visual.test.ts',
          },
        },
      })
    ).toBe('gtk3-visual.test.ts > GTK visual tests > captures the target');
  });

  it('uses the shared timestamp, arch, and root from the environment', async () => {
    const tempRoot = await createTempRoot();
    process.env.GESTAMENT_TEST_RUN_TIMESTAMP = '20260506_010203_004';
    process.env.GESTAMENT_TEST_RESULTS_ARCH = 'arm64';
    process.env.GESTAMENT_TEST_RESULTS_ROOT = tempRoot;
    delete process.env.GESTAMENT_TEST_RESULTS_GROUP;
    resetTestArtifactConfigForTesting();

    expect(getTestArtifactConfig()).toEqual({
      arch: 'arm64',
      root: tempRoot,
      runRoot: join(tempRoot, '20260506_010203_004', 'arm64'),
      timestamp: '20260506_010203_004',
    });
  });

  it('nests artifacts under an optional result group', async () => {
    const tempRoot = await createTempRoot();
    process.env.GESTAMENT_TEST_RUN_TIMESTAMP = '20260506_010203_004';
    process.env.GESTAMENT_TEST_RESULTS_ARCH = 'arm64';
    process.env.GESTAMENT_TEST_RESULTS_ROOT = tempRoot;
    process.env.GESTAMENT_TEST_RESULTS_GROUP = 'platform-gtk3';
    resetTestArtifactConfigForTesting();

    expect(getTestArtifactConfig()).toEqual({
      arch: 'arm64',
      root: tempRoot,
      runRoot: join(tempRoot, '20260506_010203_004', 'arm64', 'platform-gtk3'),
      timestamp: '20260506_010203_004',
    });

    setCurrentTestArtifact('suite > captures target', 'task-id');

    const capture: GtkCapture = {
      bounds: {
        height: 3,
        width: 2,
        x: 10,
        y: 20,
      },
      clipped: false,
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      visibleBounds: {
        height: 3,
        width: 2,
        x: 10,
        y: 20,
      },
    };
    const saved = await saveCaptureArtifact(capture, 'submit/button');

    expect(saved.pngPath).toBe(
      join(
        tempRoot,
        '20260506_010203_004',
        'arm64',
        'platform-gtk3',
        createTestArtifactDirectoryName('suite > captures target', 'task-id'),
        '000-submit_button.png'
      )
    );
    await expect(readFile(saved.pngPath)).resolves.toEqual(capture.image);
  });

  it('creates stable filesystem-safe test directory names', () => {
    expect(
      createTestArtifactDirectoryName('suite > captures / target', 'task-id')
    ).toMatch(/^suite_captures_target-[0-9a-f]{10}$/u);
  });

  it('writes capture images and metadata under the current test directory', async () => {
    const tempRoot = await createTempRoot();
    process.env.GESTAMENT_TEST_RUN_TIMESTAMP = '20260506_010203_004';
    process.env.GESTAMENT_TEST_RESULTS_ARCH = 'host';
    process.env.GESTAMENT_TEST_RESULTS_ROOT = tempRoot;
    delete process.env.GESTAMENT_TEST_RESULTS_GROUP;
    resetTestArtifactConfigForTesting();

    setCurrentTestArtifact('suite > captures target', 'task-id');

    const capture: GtkCapture = {
      bounds: {
        height: 3,
        width: 2,
        x: 10,
        y: 20,
      },
      clipped: false,
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      visibleBounds: {
        height: 3,
        width: 2,
        x: 10,
        y: 20,
      },
    };
    const saved = await saveCaptureArtifact(capture, 'submit/button');

    await expect(readFile(saved.pngPath)).resolves.toEqual(capture.image);
    await expect(
      JSON.parse(await readFile(saved.metadataPath, 'utf8'))
    ).toMatchObject({
      bounds: capture.bounds,
      clipped: false,
      imageBytes: 4,
      testId: 'task-id',
      testName: 'suite > captures target',
      visibleBounds: capture.visibleBounds,
    });
  });
});
