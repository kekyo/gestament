// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GtkCapture, GtkCaptureBounds } from '../../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

interface TestArtifactConfig {
  readonly arch: string;
  readonly root: string;
  readonly runRoot: string;
  readonly timestamp: string;
}

/**
 * Values used to build an isolated artifact configuration for tests.
 */
export interface TestArtifactConfigValues {
  /** Architecture directory name. */
  readonly arch: string;
  /** Optional result grouping directory. */
  readonly group: string | undefined;
  /** Root directory for artifact output. */
  readonly root: string;
  /** Shared test-run timestamp. */
  readonly timestamp: string;
}

interface TestTaskLike {
  readonly id: string;
  readonly name: string;
  readonly suite?: TestSuiteLike;
}

interface TestSuiteLike {
  readonly name: string;
  readonly suite?: TestSuiteLike;
}

interface CurrentTestArtifact {
  captureIndex: number;
  readonly directory: string;
  readonly id: string;
  readonly name: string;
}

let config: TestArtifactConfig | undefined;
const testArtifactConfigStorage = new AsyncLocalStorage<
  TestArtifactConfig | undefined
>();
const currentTestArtifactStorage = new AsyncLocalStorage<
  CurrentTestArtifact | undefined
>();

const padNumber = (value: number, width: number): string =>
  value.toString().padStart(width, '0');

const hashText = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 10);

const normalizePathSegment = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  const normalized = trimmed
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized.length === 0) {
    return fallback;
  }
  return normalized.length <= 140 ? normalized : normalized.slice(0, 140);
};

const serializeBounds = (
  bounds: GtkCaptureBounds
): Record<keyof GtkCaptureBounds, number> => ({
  height: bounds.height,
  width: bounds.width,
  x: bounds.x,
  y: bounds.y,
});

const createTestArtifactConfig = (
  values: TestArtifactConfigValues
): TestArtifactConfig => {
  const timestamp = values.timestamp;
  const arch = normalizePathSegment(values.arch, 'host');
  const root = resolve(values.root);
  const group =
    values.group === undefined || values.group.length === 0
      ? undefined
      : normalizePathSegment(values.group, 'group');
  const archRunRoot = join(root, timestamp, arch);

  return {
    arch,
    root,
    runRoot: group === undefined ? archRunRoot : join(archRunRoot, group),
    timestamp,
  };
};

/**
 * Formats the shared test-run timestamp used below test-results.
 * @param date Source date.
 * @returns Timestamp in YYYYMMDD_HHmmss_fff format.
 */
export const formatTestRunTimestamp = (date: Date): string =>
  `${date.getFullYear()}${padNumber(date.getMonth() + 1, 2)}${padNumber(
    date.getDate(),
    2
  )}_${padNumber(date.getHours(), 2)}${padNumber(
    date.getMinutes(),
    2
  )}${padNumber(date.getSeconds(), 2)}_${padNumber(date.getMilliseconds(), 3)}`;

/**
 * Ensures all Vitest workers observe the same test-run timestamp.
 * @returns The timestamp for this test run.
 */
export const initializeTestRunTimestamp = (): string => {
  const timestamp =
    process.env.GESTAMENT_TEST_RUN_TIMESTAMP ??
    formatTestRunTimestamp(new Date());
  process.env.GESTAMENT_TEST_RUN_TIMESTAMP = timestamp;
  return timestamp;
};

/**
 * Resolves the artifact configuration for the current test process.
 * @returns Artifact configuration.
 */
export const getTestArtifactConfig = (): TestArtifactConfig => {
  const scopedConfig = testArtifactConfigStorage.getStore();
  if (scopedConfig !== undefined) {
    return scopedConfig;
  }

  if (config !== undefined) {
    return config;
  }

  config = createTestArtifactConfig({
    arch: process.env.GESTAMENT_TEST_RESULTS_ARCH ?? 'host',
    group: process.env.GESTAMENT_TEST_RESULTS_GROUP,
    root: process.env.GESTAMENT_TEST_RESULTS_ROOT ?? 'test-results',
    timestamp: initializeTestRunTimestamp(),
  });
  return config;
};

/**
 * Runs a callback with an isolated artifact configuration for concurrent tests.
 * @param values Artifact configuration values.
 * @param callback Callback executed inside the isolated async context.
 * @returns The callback result.
 */
export const runWithTestArtifactConfigForTesting = async <T>(
  values: TestArtifactConfigValues,
  callback: () => Promise<T>
): Promise<T> =>
  await testArtifactConfigStorage.run(
    createTestArtifactConfig(values),
    callback
  );

/**
 * Resets cached artifact configuration after environment changes in tests.
 */
export const resetTestArtifactConfigForTesting = (): void => {
  config = undefined;
};

/**
 * Builds the display name used for a Vitest task.
 * @param task Vitest runner task.
 * @returns Full test name, including parent suites.
 */
export const getTaskFullName = (task: TestTaskLike): string => {
  const names = [task.name];
  let suite = task.suite;
  while (suite !== undefined) {
    if (suite.name.length > 0) {
      names.unshift(suite.name);
    }
    suite = suite.suite;
  }
  return names.join(' > ');
};

/**
 * Creates a stable directory name from a test name and Vitest task id.
 * @param testName Full test name.
 * @param testId Vitest task id.
 * @returns Filesystem-safe directory name.
 */
export const createTestArtifactDirectoryName = (
  testName: string,
  testId: string
): string => {
  const sanitizedName = normalizePathSegment(testName, 'unnamed-test');
  return `${sanitizedName}-${hashText(testId)}`;
};

/**
 * Resolves the artifact directory path for a test.
 * @param testName Full test name.
 * @param testId Vitest task id.
 * @returns Absolute artifact directory.
 */
export const getTestArtifactDirectory = (
  testName: string,
  testId: string
): string =>
  join(
    getTestArtifactConfig().runRoot,
    createTestArtifactDirectoryName(testName, testId)
  );

/**
 * Creates the artifact directory for a test.
 * @param testName Full test name.
 * @param testId Vitest task id.
 * @returns Absolute artifact directory.
 */
export const ensureTestArtifactDirectory = async (
  testName: string,
  testId: string
): Promise<string> => {
  const directory = getTestArtifactDirectory(testName, testId);
  await mkdir(directory, { recursive: true });
  return directory;
};

/**
 * Sets the active artifact directory for capture helpers.
 * @param testName Full test name.
 * @param testId Vitest task id.
 */
export const setCurrentTestArtifact = (
  testName: string,
  testId: string
): void => {
  currentTestArtifactStorage.enterWith({
    captureIndex: 0,
    directory: getTestArtifactDirectory(testName, testId),
    id: testId,
    name: testName,
  });
};

/**
 * Clears the active artifact directory for capture helpers.
 */
export const clearCurrentTestArtifact = (): void => {
  currentTestArtifactStorage.enterWith(undefined);
};

/**
 * Saves a GTK capture image and its metadata under the current test directory.
 * @param capture GTK capture.
 * @param label Label used in the artifact filename.
 * @returns Paths written by the helper.
 */
export const saveCaptureArtifact = async (
  capture: GtkCapture,
  label: string
): Promise<{
  readonly metadataPath: string;
  readonly pngPath: string;
}> => {
  const currentTestArtifact = currentTestArtifactStorage.getStore();
  if (currentTestArtifact === undefined) {
    throw new Error('No active test artifact directory.');
  }

  const index = currentTestArtifact.captureIndex;
  currentTestArtifact.captureIndex += 1;

  const baseName = `${padNumber(index, 3)}-${normalizePathSegment(
    label,
    'capture'
  )}`;
  const directory = currentTestArtifact.directory;
  await mkdir(directory, { recursive: true });

  const pngPath = join(directory, `${baseName}.png`);
  const metadataPath = join(directory, `${baseName}.json`);
  await writeFile(pngPath, capture.image);
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        bounds: serializeBounds(capture.bounds),
        clipped: capture.clipped,
        imageBytes: capture.image.length,
        testId: currentTestArtifact.id,
        testName: currentTestArtifact.name,
        visibleBounds: serializeBounds(capture.visibleBounds),
      },
      undefined,
      2
    )}\n`
  );

  return {
    metadataPath,
    pngPath,
  };
};
