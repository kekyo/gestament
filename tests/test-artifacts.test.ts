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
  runWithTestArtifactConfigForTesting,
  saveCaptureArtifact,
  setCurrentTestArtifact,
} from './support/testArtifacts';
import type { GtkCapture } from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

interface TempTestArtifactConfigValues {
  readonly arch: string;
  readonly group: string | undefined;
  readonly timestamp: string;
}

const withTempTestArtifactConfig = async <T>(
  values: TempTestArtifactConfigValues,
  callback: (tempRoot: string) => Promise<T>
): Promise<T> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-test-artifacts-'));
  try {
    return await runWithTestArtifactConfigForTesting(
      {
        arch: values.arch,
        group: values.group,
        root: tempRoot,
        timestamp: values.timestamp,
      },
      async () => await callback(tempRoot)
    );
  } finally {
    await rm(tempRoot, {
      force: true,
      recursive: true,
    });
  }
};

const wait = (delayMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

afterEach(() => {
  clearCurrentTestArtifact();
  resetTestArtifactConfigForTesting();
});

/////////////////////////////////////////////////////////////////////////////////////////

describe.concurrent('test artifact paths', () => {
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

  it('uses the shared timestamp, arch, and root from the active configuration', async () => {
    await withTempTestArtifactConfig(
      {
        arch: 'arm64',
        group: undefined,
        timestamp: '20260506_010203_004',
      },
      async (tempRoot) => {
        expect(getTestArtifactConfig()).toEqual({
          arch: 'arm64',
          root: tempRoot,
          runRoot: join(tempRoot, '20260506_010203_004', 'arm64'),
          timestamp: '20260506_010203_004',
        });
      }
    );
  });

  it('nests artifacts under an optional result group', async () => {
    await withTempTestArtifactConfig(
      {
        arch: 'arm64',
        group: 'platform-gtk3',
        timestamp: '20260506_010203_004',
      },
      async (tempRoot) => {
        expect(getTestArtifactConfig()).toEqual({
          arch: 'arm64',
          root: tempRoot,
          runRoot: join(
            tempRoot,
            '20260506_010203_004',
            'arm64',
            'platform-gtk3'
          ),
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
            createTestArtifactDirectoryName(
              'suite > captures target',
              'task-id'
            ),
            '000-submit_button.png'
          )
        );
        await expect(readFile(saved.pngPath)).resolves.toEqual(capture.image);
      }
    );
  });

  it('creates stable filesystem-safe test directory names', () => {
    expect(
      createTestArtifactDirectoryName('suite > captures / target', 'task-id')
    ).toMatch(/^suite_captures_target-[0-9a-f]{10}$/u);
  });

  it('writes capture images and metadata under the current test directory', async () => {
    await withTempTestArtifactConfig(
      {
        arch: 'host',
        group: undefined,
        timestamp: '20260506_010203_004',
      },
      async () => {
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
      }
    );
  });

  it('keeps active artifact directories isolated across concurrent async flows', async () => {
    await withTempTestArtifactConfig(
      {
        arch: 'host',
        group: undefined,
        timestamp: '20260506_010203_004',
      },
      async (tempRoot) => {
        const firstCapture: GtkCapture = {
          bounds: {
            height: 1,
            width: 1,
            x: 0,
            y: 0,
          },
          clipped: false,
          image: Buffer.from([0x01]),
          visibleBounds: {
            height: 1,
            width: 1,
            x: 0,
            y: 0,
          },
        };
        const secondCapture: GtkCapture = {
          bounds: {
            height: 1,
            width: 2,
            x: 3,
            y: 4,
          },
          clipped: false,
          image: Buffer.from([0x02, 0x03]),
          visibleBounds: {
            height: 1,
            width: 2,
            x: 3,
            y: 4,
          },
        };

        const first = async (): Promise<
          Awaited<ReturnType<typeof saveCaptureArtifact>>
        > => {
          setCurrentTestArtifact('suite > first target', 'first-task-id');
          await wait(10);
          return await saveCaptureArtifact(firstCapture, 'target');
        };
        const second = async (): Promise<
          Awaited<ReturnType<typeof saveCaptureArtifact>>
        > => {
          setCurrentTestArtifact('suite > second target', 'second-task-id');
          return await saveCaptureArtifact(secondCapture, 'target');
        };

        const [firstSaved, secondSaved] = await Promise.all([
          first(),
          second(),
        ]);

        expect(firstSaved.pngPath).toBe(
          join(
            tempRoot,
            '20260506_010203_004',
            'host',
            createTestArtifactDirectoryName(
              'suite > first target',
              'first-task-id'
            ),
            '000-target.png'
          )
        );
        expect(secondSaved.pngPath).toBe(
          join(
            tempRoot,
            '20260506_010203_004',
            'host',
            createTestArtifactDirectoryName(
              'suite > second target',
              'second-task-id'
            ),
            '000-target.png'
          )
        );
        await expect(readFile(firstSaved.pngPath)).resolves.toEqual(
          firstCapture.image
        );
        await expect(readFile(secondSaved.pngPath)).resolves.toEqual(
          secondCapture.image
        );
        await expect(
          JSON.parse(await readFile(firstSaved.metadataPath, 'utf8'))
        ).toMatchObject({
          testId: 'first-task-id',
          testName: 'suite > first target',
        });
        await expect(
          JSON.parse(await readFile(secondSaved.metadataPath, 'utf8'))
        ).toMatchObject({
          testId: 'second-task-id',
          testName: 'suite > second target',
        });
      }
    );
  });
});
