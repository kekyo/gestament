// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { expect } from 'vitest';
import { PNG } from 'pngjs';

/////////////////////////////////////////////////////////////////////////////////////////

/** Rectangular PNG pixel region. */
export interface PngPixelRegion {
  /** Left pixel offset. */
  readonly x: number;

  /** Top pixel offset. */
  readonly y: number;

  /** Region width in pixels. */
  readonly width: number;

  /** Region height in pixels. */
  readonly height: number;
}

/**
 * Verifies that a captured PNG contains dark foreground pixels.
 * @param image PNG image buffer.
 * @param minimumPixelCount Minimum expected number of dark pixels.
 */
export const expectPngToContainDarkPixels = (
  image: Buffer,
  minimumPixelCount: number
): void => {
  const png = PNG.sync.read(image);
  let darkPixelCount = 0;

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const alpha = png.data[index + 3];
    if (
      red !== undefined &&
      green !== undefined &&
      blue !== undefined &&
      alpha !== undefined &&
      alpha > 0 &&
      red < 160 &&
      green < 160 &&
      blue < 160
    ) {
      darkPixelCount += 1;
    }
  }

  expect(darkPixelCount).toBeGreaterThanOrEqual(minimumPixelCount);
};

/**
 * Verifies that a captured PNG contains pixels distinguishable from a light
 * blank background.
 * @param image PNG image buffer.
 * @param minimumPixelCount Minimum expected number of non-light pixels.
 */
export const expectPngToContainNonLightPixels = (
  image: Buffer,
  minimumPixelCount: number
): void => {
  const png = PNG.sync.read(image);
  let nonLightPixelCount = 0;

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const alpha = png.data[index + 3];
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

  expect(nonLightPixelCount).toBeGreaterThanOrEqual(minimumPixelCount);
};

/**
 * Verifies that a captured PNG region contains saturated icon-like pixels.
 * @param image PNG image buffer.
 * @param region Pixel region to inspect.
 * @param minimumPixelCount Minimum expected number of saturated pixels.
 */
export const expectPngRegionToContainSaturatedPixels = (
  image: Buffer,
  region: PngPixelRegion,
  minimumPixelCount: number
): void => {
  const png = PNG.sync.read(image);
  let saturatedPixelCount = 0;

  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(png.width, region.x + region.width);
  const bottom = Math.min(png.height, region.y + region.height);

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (png.width * y + x) * 4;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      const alpha = png.data[index + 3];
      if (
        red !== undefined &&
        green !== undefined &&
        blue !== undefined &&
        alpha !== undefined &&
        alpha > 0 &&
        Math.max(red, green, blue) - Math.min(red, green, blue) >= 40
      ) {
        saturatedPixelCount += 1;
      }
    }
  }

  expect(saturatedPixelCount).toBeGreaterThanOrEqual(minimumPixelCount);
};

/**
 * Verifies that a captured PNG region contains pixels distinguishable from a
 * light blank background.
 * @param image PNG image buffer.
 * @param region Pixel region to inspect.
 * @param minimumPixelCount Minimum expected number of non-light pixels.
 */
export const expectPngRegionToContainNonLightPixels = (
  image: Buffer,
  region: PngPixelRegion,
  minimumPixelCount: number
): void => {
  const png = PNG.sync.read(image);
  let nonLightPixelCount = 0;

  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(png.width, region.x + region.width);
  const bottom = Math.min(png.height, region.y + region.height);

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (png.width * y + x) * 4;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      const alpha = png.data[index + 3];
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
  }

  expect(nonLightPixelCount).toBeGreaterThanOrEqual(minimumPixelCount);
};
