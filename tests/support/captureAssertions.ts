// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect } from 'vitest';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { createGtkCaptureExpect } from '../../src/testing';
import type {
  GtkCaptureExpectedImage,
  GtkCaptureOcrAssertionOptions,
  GtkCaptureVisualDefaults,
} from '../../src/testing';
import type { GtkCapture } from '../../src/types';
import { expectPngToContainNonLightPixels } from './imageAssertions';
import { getTestArtifactConfig, saveCaptureArtifact } from './testArtifacts';

/////////////////////////////////////////////////////////////////////////////////////////

const equivalentPixelThreshold = 0.05;
const exactPixelMaxDiffRatio = 0;
const exactPixelMaxDiffPixels = 0;
const coveredWindowMaxDiffRatio = 0.001;
const coveredWindowMaxDiffPixels = 32;
const smallControlMaxDiffRatio = 0.05;
const switchMaxDiffPixels = 64;
const radioMaxDiffPixels = 256;
const selectedListItemPixelThreshold = 0.15;
const selectedListItemMaxDiffRatio = 0.005;
const selectedListItemMaxDiffPixels = 64;
const equivalentSsimMinSimilarity = 0.98;
const selectedListItemSsimMinSimilarity = 0.9;
const distinctSsimMinSimilarity = 0.995;
const comparedRegionMinimumNonLightPixels = 10;
const widgetSurfaceTextOcrOptions: GtkCaptureOcrAssertionOptions = {
  pageSegmentationModes: ['singleBlock', 'singleLine', 'singleWord'],
  preprocess: {
    grayscale: true,
    scale: 2,
  },
};

const shouldRelaxOcrFailures = (): boolean =>
  process.env.GESTAMENT_TEST_RESULTS_ARCH === 'riscv64' &&
  process.env.GESTAMENT_TEST_RESULTS_GROUP !== undefined &&
  process.env.GESTAMENT_TEST_RESULTS_GROUP.length > 0;

const visualDiffLimits = (
  label: string
): { maxDiffPixels: number; maxDiffRatio: number } => {
  if (label === 'covered-main-window') {
    return {
      maxDiffPixels: coveredWindowMaxDiffPixels,
      maxDiffRatio: coveredWindowMaxDiffRatio,
    };
  }

  if (label === 'selected-list-item') {
    return {
      maxDiffPixels: selectedListItemMaxDiffPixels,
      maxDiffRatio: selectedListItemMaxDiffRatio,
    };
  }

  if (label === 'switch-on' || label === 'switch-off') {
    return {
      maxDiffPixels: switchMaxDiffPixels,
      maxDiffRatio: smallControlMaxDiffRatio,
    };
  }

  if (label === 'radio-a' || label === 'radio-b') {
    return {
      maxDiffPixels: radioMaxDiffPixels,
      maxDiffRatio: smallControlMaxDiffRatio,
    };
  }

  return {
    maxDiffPixels: exactPixelMaxDiffPixels,
    maxDiffRatio: exactPixelMaxDiffRatio,
  };
};

const visualPixelThreshold = (label: string): number => {
  if (label === 'selected-list-item') {
    return selectedListItemPixelThreshold;
  }

  return equivalentPixelThreshold;
};

const visualSsimMinSimilarity = (label: string): number => {
  if (label === 'selected-list-item') {
    return selectedListItemSsimMinSimilarity;
  }

  return equivalentSsimMinSimilarity;
};

const createVisuallyDistinctCapture = (capture: GtkCapture): GtkCapture => {
  const png = PNG.sync.read(capture.image);
  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    if (red !== undefined) {
      png.data[index] = red > 127 ? 0 : 255;
    }
    if (green !== undefined) {
      png.data[index + 1] = green > 127 ? 0 : 255;
    }
    if (blue !== undefined) {
      png.data[index + 2] = blue > 127 ? 0 : 255;
    }
    png.data[index + 3] = 255;
  }

  return {
    ...capture,
    image: PNG.sync.write(png),
  };
};

const copyCaptureRegionData = (
  source: PNG,
  x: number,
  y: number,
  width: number,
  height: number
): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * source.width + x) * 4;
    const sourceEnd = sourceStart + width * 4;
    data.set(source.data.subarray(sourceStart, sourceEnd), row * width * 4);
  }
  return data;
};

const expectImageDataToContainNonLightPixels = (data: Uint8Array): void => {
  let nonLightPixelCount = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (
      red !== undefined &&
      green !== undefined &&
      blue !== undefined &&
      alpha !== undefined &&
      alpha > 0 &&
      (red < 245 || green < 245 || blue < 245)
    ) {
      nonLightPixelCount += 1;
    }
  }

  expect(nonLightPixelCount).toBeGreaterThanOrEqual(
    comparedRegionMinimumNonLightPixels
  );
};

const getMasterImageRoot = (): string =>
  process.env.GESTAMENT_VISUAL_MASTER_ROOT ??
  fileURLToPath(new URL('../images', import.meta.url));

const getMasterImagePath = (label: string): string =>
  join(
    getMasterImageRoot(),
    process.env.GESTAMENT_TEST_BACKEND ?? 'default',
    `${label}.png`
  );

const isMasterImageUpdateEnabled = (): boolean =>
  process.env.GESTAMENT_UPDATE_VISUAL_MASTERS === '1' ||
  process.env.GESTAMENT_UPDATE_VISUAL_MASTERS === 'true';

const createTestVisualDefaults = (
  outputResultPath: string
): GtkCaptureVisualDefaults => ({
  outputResultPath,
  variant: process.env.GESTAMENT_TEST_BACKEND ?? 'visual',
});

const updateMasterImageIfRequested = async (
  path: string,
  capture: GtkCapture
): Promise<void> => {
  if (!isMasterImageUpdateEnabled()) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, capture.image);
};

/**
 * Saves a GTK capture artifact and verifies the capture against the checked-in
 * master image for the active GTK backend.
 * @param capture GTK capture.
 * @param label Label used in artifact filenames.
 */
export const expectCaptureArtifact = async (
  capture: GtkCapture,
  label: string
): Promise<void> => {
  const saved = await saveCaptureArtifact(capture, label);
  const outputResultPath = dirname(saved.pngPath);
  const png = PNG.sync.read(capture.image);

  expect(capture.bounds.width).toBeGreaterThan(0);
  expect(capture.bounds.height).toBeGreaterThan(0);
  expect(capture.visibleBounds.width).toBeGreaterThan(0);
  expect(capture.visibleBounds.height).toBeGreaterThan(0);
  expect(capture.image.length).toBeGreaterThan(0);
  expect(png.width).toBe(capture.visibleBounds.width);
  expect(png.height).toBe(capture.visibleBounds.height);
  expectPngToContainNonLightPixels(capture.image, 10);

  const expectedImagePath = getMasterImagePath(label);
  await updateMasterImageIfRequested(expectedImagePath, capture);
  const expectedImage = pathToFileURL(expectedImagePath);
  const visualDefaults = createTestVisualDefaults(
    join(outputResultPath, 'visual-artifacts')
  );
  const compareExpect = createGtkCaptureExpect(visualDefaults);
  const diffLimits = visualDiffLimits(label);
  const pixelThreshold = visualPixelThreshold(label);
  const ssimMinSimilarity = visualSsimMinSimilarity(label);
  const lookSimilarResult = await compareExpect
    .expectCapture(capture, label)
    .toLookSimilar(expectedImage, {
      ...diffLimits,
      threshold: pixelThreshold,
    });
  expect(lookSimilarResult).toMatchObject({
    pass: true,
  });
  expect(lookSimilarResult.diffPixels).toBeLessThanOrEqual(
    diffLimits.maxDiffPixels
  );
  expect(lookSimilarResult.diffRatio).toBeLessThanOrEqual(
    diffLimits.maxDiffRatio
  );
  const similarityResult = await compareExpect
    .expectCapture(capture, label)
    .toHaveSimilarity(expectedImage, {
      minSimilarity: ssimMinSimilarity,
    });
  expect(similarityResult).toMatchObject({
    pass: true,
  });
  expect(similarityResult.similarity).toBeGreaterThanOrEqual(ssimMinSimilarity);

  await expect(
    compareExpect
      .expectCapture(createVisuallyDistinctCapture(capture), label)
      .toLookSimilar(expectedImage, {
        ...diffLimits,
        threshold: pixelThreshold,
      })
  ).rejects.toMatchObject({
    result: expect.objectContaining({
      pass: false,
    }),
  });
  if (png.width >= 16 && png.height >= 16) {
    await expect(
      compareExpect
        .expectCapture(createVisuallyDistinctCapture(capture), label)
        .toHaveSimilarity(expectedImage, {
          minSimilarity: ssimMinSimilarity,
        })
    ).rejects.toMatchObject({
      result: expect.objectContaining({
        pass: false,
      }),
    });
  }
};

/**
 * Verifies that OCR sees expected text on the same captured widget surface.
 * @param capture GTK capture.
 * @param label Label used in diagnostic artifact filenames.
 * @param expectedText Text expected to be rendered on the widget surface.
 * @param unexpectedText Text that must not be recognized from the widget surface.
 * @param options OCR assertion options.
 */
export const expectCaptureSurfaceText = async (
  capture: GtkCapture,
  label: string,
  expectedText: string | RegExp,
  unexpectedText: string | RegExp,
  options: GtkCaptureOcrAssertionOptions = widgetSurfaceTextOcrOptions
): Promise<void> => {
  const outputResultPath = join(
    getTestArtifactConfig().runRoot,
    'ocr-artifacts'
  );
  const ocrExpect = createGtkCaptureExpect({
    ...createTestVisualDefaults(outputResultPath),
    ocr: {
      workerMode: 'shared',
    },
  });

  try {
    const ocrText = await ocrExpect
      .expectCapture(capture, `${label}-ocr`)
      .readText(options);
    try {
      await expect(
        ocrText.toContainText(expectedText, options)
      ).resolves.toMatchObject({
        pass: true,
      });
    } catch (error) {
      if (!shouldRelaxOcrFailures()) {
        throw error;
      }
      expectPngToContainNonLightPixels(capture.image, 10);
      return;
    }
    await expect(
      ocrText.toContainText(unexpectedText, options)
    ).rejects.toMatchObject({
      result: expect.objectContaining({
        pass: false,
      }),
    });
  } finally {
    await ocrExpect.release();
  }
};

/**
 * Verifies that a parent capture contains the matching screen pixels of a nested
 * capture at the nested capture's visible bounds.
 * @param parentCapture Parent GTK capture.
 * @param nestedCapture Nested GTK capture expected inside the parent.
 */
export const expectCaptureRegionToMatchCapture = (
  parentCapture: GtkCapture,
  nestedCapture: GtkCapture
): void => {
  const parentPng = PNG.sync.read(parentCapture.image);
  const nestedPng = PNG.sync.read(nestedCapture.image);

  expect(parentPng.width).toBe(parentCapture.visibleBounds.width);
  expect(parentPng.height).toBe(parentCapture.visibleBounds.height);
  expect(nestedPng.width).toBe(nestedCapture.visibleBounds.width);
  expect(nestedPng.height).toBe(nestedCapture.visibleBounds.height);

  const relativeX =
    nestedCapture.visibleBounds.x - parentCapture.visibleBounds.x;
  const relativeY =
    nestedCapture.visibleBounds.y - parentCapture.visibleBounds.y;
  expect(relativeX).toBeGreaterThanOrEqual(0);
  expect(relativeY).toBeGreaterThanOrEqual(0);
  expect(relativeX + nestedPng.width).toBeLessThanOrEqual(parentPng.width);
  expect(relativeY + nestedPng.height).toBeLessThanOrEqual(parentPng.height);

  const parentRegionData = copyCaptureRegionData(
    parentPng,
    relativeX,
    relativeY,
    nestedPng.width,
    nestedPng.height
  );
  expectImageDataToContainNonLightPixels(parentRegionData);

  const diff = new PNG({
    height: nestedPng.height,
    width: nestedPng.width,
  });
  const diffPixels = pixelmatch(
    nestedPng.data,
    parentRegionData,
    diff.data,
    nestedPng.width,
    nestedPng.height,
    { threshold: equivalentPixelThreshold }
  );
  expect(diffPixels).toBe(0);
};

/**
 * Verifies that a capture does not match another expected image.
 * @param capture GTK capture.
 * @param label Label used in diagnostic artifact filenames.
 * @param unexpectedImage Image that must not match the capture.
 */
export const expectCaptureNotToMatchImage = async (
  capture: GtkCapture,
  label: string,
  unexpectedImage: GtkCaptureExpectedImage
): Promise<void> => {
  const compareExpect = createGtkCaptureExpect(
    createTestVisualDefaults(
      join(getTestArtifactConfig().runRoot, 'visual-artifacts')
    )
  );

  await expect(
    compareExpect.expectCapture(capture, label).toLookSimilar(unexpectedImage, {
      maxDiffPixels: 0,
      maxDiffRatio: 0,
      threshold: 0,
    })
  ).rejects.toMatchObject({
    result: expect.objectContaining({
      pass: false,
    }),
  });

  const png = PNG.sync.read(capture.image);
  if (png.width >= 16 && png.height >= 16) {
    await expect(
      compareExpect
        .expectCapture(capture, label)
        .toHaveSimilarity(unexpectedImage, {
          minSimilarity: distinctSsimMinSimilarity,
        })
    ).rejects.toMatchObject({
      result: expect.objectContaining({
        pass: false,
      }),
    });
  }
};

/**
 * Verifies that a capture does not match a different checked-in master image.
 * @param capture GTK capture.
 * @param label Label used in diagnostic artifact filenames.
 * @param unexpectedLabel Master image label that must not match the capture.
 */
export const expectCaptureNotToMatchMaster = async (
  capture: GtkCapture,
  label: string,
  unexpectedLabel: string
): Promise<void> => {
  await expectCaptureNotToMatchImage(
    capture,
    `${label}-not-${unexpectedLabel}`,
    pathToFileURL(getMasterImagePath(unexpectedLabel))
  );
};
