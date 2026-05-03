// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ssim } from 'ssim.js';
import englishLanguageData from '@tesseract.js-data/eng';

import type { GtkCapture, GtkCaptureBounds, Releasable } from './types';

/////////////////////////////////////////////////////////////////////////////////////////

/** Pixel region inside a captured PNG image. */
export interface GtkCapturePixelRegion {
  /** Left pixel offset from the capture image origin. */
  readonly x: number;

  /** Top pixel offset from the capture image origin. */
  readonly y: number;

  /** Region width in pixels. */
  readonly width: number;

  /** Region height in pixels. */
  readonly height: number;
}

/**
 * Expected PNG image source for GTK capture visual assertions.
 * @remarks Strings are interpreted as filesystem paths. URL values must use the file protocol.
 */
export type GtkCaptureExpectedImage = Buffer | string | URL;

/** Tesseract page segmentation mode used by GTK capture OCR assertions. */
export type GtkCaptureOcrPageSegmentationMode =
  | 'osdOnly'
  | 'autoOsd'
  | 'autoOnly'
  | 'auto'
  | 'singleColumn'
  | 'singleBlockVerticalText'
  | 'singleBlock'
  | 'singleLine'
  | 'singleWord'
  | 'circleWord'
  | 'singleChar'
  | 'sparseText'
  | 'sparseTextOsd'
  | 'rawLine';

/** Worker lifecycle mode used by GTK capture OCR assertions. */
export type GtkCaptureOcrWorkerMode = 'perRead' | 'shared';

/** Cache mode passed to Tesseract.js language data loading. */
export type GtkCaptureOcrCacheMethod =
  | 'write'
  | 'readOnly'
  | 'refresh'
  | 'none';

/** Defaults shared by GTK capture OCR assertions. */
export interface GtkCaptureOcrDefaults {
  /**
   * Tesseract.js worker lifecycle mode.
   * @remarks The default is perRead, which creates and terminates a worker for each OCR read.
   */
  readonly workerMode?: GtkCaptureOcrWorkerMode;

  /**
   * OCR language code or language code list.
   * @remarks The default is eng. Multiple languages are joined with + for Tesseract.js.
   */
  readonly languages?: string | readonly string[];

  /**
   * Tesseract.js core path.
   * @remarks Omit to use Tesseract.js defaults.
   */
  readonly corePath?: string;

  /**
   * Tesseract.js worker script path.
   * @remarks Omit to use Tesseract.js defaults.
   */
  readonly workerPath?: string;

  /**
   * Language data path passed to Tesseract.js.
   * @remarks Omit to use bundled English traineddata when languages is eng.
   */
  readonly langPath?: string;

  /**
   * Language data cache path passed to Tesseract.js.
   * @remarks Omit to let the selected cacheMethod decide whether Tesseract.js writes a cache file.
   */
  readonly cachePath?: string;

  /**
   * Language data cache behavior passed to Tesseract.js.
   * @remarks The default is none when bundled English traineddata is used.
   */
  readonly cacheMethod?: GtkCaptureOcrCacheMethod;

  /**
   * Whether language data is gzipped.
   * @remarks The default follows the selected language data source.
   */
  readonly gzip?: boolean;
}

/** Output settings shared by GTK capture assertions. */
export interface GtkCaptureResultOutputOptions {
  /**
   * Output directory used as the base path for actual, expected, diff, and metadata files.
   * @remarks Output files are written only when outputResultPath or GESTAMENT_VISUAL_OUTPUT_RESULT_PATH is specified.
   */
  readonly outputResultPath?: string;

  /**
   * Artifact variant, usually a GTK backend or platform name.
   * @remarks This value does not enable artifact output by itself.
   */
  readonly variant?: string;
}

/** Defaults shared by GTK capture visual and OCR assertions. */
export interface GtkCaptureVisualDefaults extends GtkCaptureResultOutputOptions {
  /**
   * Defaults for OCR assertions.
   * @remarks OCR workers are created lazily only when an OCR assertion is used.
   */
  readonly ocr?: GtkCaptureOcrDefaults;
}

/** Options shared by visual comparison assertions. */
export interface GtkCaptureVisualComparisonOptions extends GtkCaptureResultOutputOptions {
  /** Region to compare. Omit to compare the full capture image. */
  readonly region?: GtkCapturePixelRegion;

  /** Regions to ignore during comparison. Coordinates use the full capture image. */
  readonly masks?: readonly GtkCapturePixelRegion[];
}

/** Options for pixel-difference based capture comparison. */
export interface GtkCaptureLookSimilarOptions extends GtkCaptureVisualComparisonOptions {
  /** Pixelmatch color threshold from 0 to 1. */
  readonly threshold?: number;

  /** Maximum allowed mismatched pixel count. */
  readonly maxDiffPixels?: number;

  /** Maximum allowed mismatched pixel ratio from 0 to 1. */
  readonly maxDiffRatio?: number;
}

/** Options for structural-similarity (SSIM) based capture comparison. */
export interface GtkCaptureSimilarityOptions extends GtkCaptureVisualComparisonOptions {
  /** Minimum allowed MSSIM score from 0 to 1. */
  readonly minSimilarity?: number;
}

/** Image preprocessing options applied before OCR recognition. */
export interface GtkCaptureOcrPreprocessOptions {
  /**
   * Nearest-neighbor scale factor applied after cropping.
   * @remarks The default is 1.
   */
  readonly scale?: number;

  /**
   * Converts RGB pixels to Rec. 709 luminance before OCR.
   * @remarks Thresholding also uses luminance even when this is false.
   */
  readonly grayscale?: boolean;

  /**
   * Converts luminance values to black or white using this threshold from 0 to 255.
   * @remarks Omit to keep continuous color or grayscale values.
   */
  readonly threshold?: number;

  /**
   * Inverts RGB values after grayscale or threshold processing.
   * @remarks Alpha values are preserved.
   */
  readonly invert?: boolean;
}

/** Options for reading text from a GTK capture with OCR. */
export interface GtkCaptureOcrOptions extends GtkCaptureResultOutputOptions {
  /** Region to pass to OCR. Omit to read the full capture image. */
  readonly region?: GtkCapturePixelRegion;

  /**
   * Tesseract page segmentation modes to try.
   * @remarks The default tries singleBlock, sparseText, singleLine, and singleWord.
   */
  readonly pageSegmentationModes?: readonly GtkCaptureOcrPageSegmentationMode[];

  /** Image preprocessing applied before OCR recognition. */
  readonly preprocess?: GtkCaptureOcrPreprocessOptions;

  /**
   * Additional Tesseract worker parameters applied before each recognition attempt.
   * @remarks tessedit_pageseg_mode is overwritten for each selected pageSegmentationMode.
   */
  readonly parameters?: Readonly<Record<string, string>>;
}

/** Options applied when matching OCR text against an expected value. */
export interface GtkCaptureOcrTextAssertionOptions {
  /**
   * Whether string expectations are case-sensitive.
   * @remarks The default is false. Regular expressions use their own flags.
   */
  readonly caseSensitive?: boolean;

  /**
   * Whether OCR text whitespace is collapsed before matching.
   * @remarks The default is true.
   */
  readonly normalizeWhitespace?: boolean;

  /**
   * Minimum confidence required for a matching OCR attempt.
   * @remarks Omit to accept any confidence value returned by Tesseract.js.
   */
  readonly minConfidence?: number;
}

/** Options for asserting OCR text directly from a GTK capture. */
export interface GtkCaptureOcrAssertionOptions
  extends GtkCaptureOcrOptions, GtkCaptureOcrTextAssertionOptions {}

/** Common result fields returned by GTK capture visual assertions. */
export interface GtkCaptureVisualResult {
  /** Whether the assertion passed. */
  readonly pass: boolean;

  /** Output directory for this assertion call, present when result output is enabled. */
  readonly outputResultPath?: string;

  /** Saved actual PNG path, present when result output is enabled. */
  readonly actualImagePath?: string;

  /** Saved metadata JSON path, present when result output is enabled. */
  readonly metadataJsonPath?: string;

  /** Saved expected PNG path, present when failure output was generated. */
  readonly expectedImagePath?: string;

  /** Saved diff PNG path, present when a diff image was generated. */
  readonly diffImagePath?: string;
}

/** Result returned by pixel-difference based capture comparison. */
export interface GtkCaptureLookSimilarResult extends GtkCaptureVisualResult {
  /** Number of mismatched pixels after region and mask processing. */
  readonly diffPixels: number;

  /** Mismatched pixel ratio after region and mask processing. */
  readonly diffRatio: number;

  /** Number of pixels included in the comparison region. */
  readonly totalPixels: number;
}

/** Result returned by structural-similarity based capture comparison. */
export interface GtkCaptureSimilarityResult extends GtkCaptureVisualResult {
  /** MSSIM score returned by ssim.js. */
  readonly similarity: number;

  /** Diagnostic mismatched pixel count generated by pixelmatch. */
  readonly diffPixels: number;

  /** Diagnostic mismatched pixel ratio generated by pixelmatch. */
  readonly diffRatio: number;

  /** Number of pixels included in the comparison region. */
  readonly totalPixels: number;
}

/** One OCR recognition attempt for a GTK capture. */
export interface GtkCaptureOcrAttempt {
  /** Page segmentation mode used for this attempt. */
  readonly pageSegmentationMode: GtkCaptureOcrPageSegmentationMode;

  /** Raw text returned by Tesseract.js. */
  readonly text: string;

  /** Whitespace-normalized text returned by Tesseract.js. */
  readonly normalizedText: string;

  /** Confidence score returned by Tesseract.js. */
  readonly confidence: number;
}

/** Result returned by OCR text assertions. */
export interface GtkCaptureOcrResult extends GtkCaptureVisualResult {
  /** Raw text selected from the best OCR attempt. */
  readonly text: string;

  /** Whitespace-normalized text selected from the best OCR attempt. */
  readonly normalizedText: string;

  /** Confidence score from the selected OCR attempt. */
  readonly confidence: number;

  /** Page segmentation mode from the selected OCR attempt. */
  readonly pageSegmentationMode: GtkCaptureOcrPageSegmentationMode;

  /** All OCR recognition attempts produced for this assertion. */
  readonly attempts: readonly GtkCaptureOcrAttempt[];

  /** Expected OCR text matcher as a diagnostic string. */
  readonly expectedText: string;

  /** Saved OCR input PNG path, present when result output is enabled. */
  readonly ocrInputImagePath?: string;
}

/** OCR text read from a GTK capture and reusable for multiple assertions. */
export interface GtkCaptureOcrText {
  /** Raw text selected from the best OCR attempt. */
  readonly text: string;

  /** Whitespace-normalized text selected from the best OCR attempt. */
  readonly normalizedText: string;

  /** Confidence score from the selected OCR attempt. */
  readonly confidence: number;

  /** Page segmentation mode from the selected OCR attempt. */
  readonly pageSegmentationMode: GtkCaptureOcrPageSegmentationMode;

  /** All OCR recognition attempts produced for this read. */
  readonly attempts: readonly GtkCaptureOcrAttempt[];

  /** Output directory for this OCR read, present when result output is enabled. */
  readonly outputResultPath?: string;

  /** Saved actual PNG path, present when result output is enabled. */
  readonly actualImagePath?: string;

  /** Saved OCR input PNG path, present when result output is enabled. */
  readonly ocrInputImagePath?: string;

  /** Saved metadata JSON path, present when result output is enabled. */
  readonly metadataJsonPath?: string;

  /**
   * Asserts that this OCR text contains the expected string or matches the expected regular expression.
   * @param expected Expected string or regular expression.
   * @param options Text matching options.
   * @returns OCR assertion result when the assertion passes.
   */
  readonly toContainText: (
    expected: string | RegExp,
    options?: GtkCaptureOcrTextAssertionOptions
  ) => Promise<GtkCaptureOcrResult>;
}

/** Error thrown by GTK capture visual assertions. */
export interface GtkCaptureVisualError<
  Result extends GtkCaptureVisualResult = GtkCaptureVisualResult,
> extends Error {
  /** Assertion result and artifact paths available at the failure point. */
  readonly result: Result;
}

/** Assertion object for a single GTK capture image. */
export interface GtkCaptureExpectation {
  /**
   * Compares the capture against an expected PNG image with pixel-level tolerance.
   * @param expectedImage Expected PNG image as a buffer, path string, or file URL.
   * @param options Comparison options.
   * @returns Comparison result when the assertion passes.
   */
  readonly toLookSimilar: (
    expectedImage: GtkCaptureExpectedImage,
    options?: GtkCaptureLookSimilarOptions
  ) => Promise<GtkCaptureLookSimilarResult>;

  /**
   * Compares the capture against an expected PNG image with structural similarity (SSIM).
   * @param expectedImage Expected PNG image as a buffer, path string, or file URL.
   * @param options Comparison options.
   * @returns Comparison result when the assertion passes.
   */
  readonly toHaveSimilarity: (
    expectedImage: GtkCaptureExpectedImage,
    options?: GtkCaptureSimilarityOptions
  ) => Promise<GtkCaptureSimilarityResult>;

  /**
   * Reads text from the capture with OCR and asserts that it contains expected text.
   * @param expected Expected string or regular expression.
   * @param options OCR and text matching options.
   * @returns OCR assertion result when the assertion passes.
   */
  readonly toContainText: (
    expected: string | RegExp,
    options?: GtkCaptureOcrAssertionOptions
  ) => Promise<GtkCaptureOcrResult>;

  /**
   * Reads text from the capture with OCR for reusable text assertions.
   * @param options OCR options.
   * @returns OCR text object that can run multiple assertions without recognizing again.
   */
  readonly readText: (
    options?: GtkCaptureOcrOptions
  ) => Promise<GtkCaptureOcrText>;
}

/** Factory for GTK capture visual assertions. */
export interface GtkCaptureExpect extends Releasable {
  /**
   * Creates an assertion object for a captured GTK image.
   * @param capture GTK capture to assert.
   * @param name Artifact name.
   * @returns Assertion object for the capture.
   */
  readonly expectCapture: (
    capture: GtkCapture,
    name: string
  ) => GtkCaptureExpectation;
}

interface ResolvedDefaults {
  readonly outputResultPath: string;
  readonly variant: string;
}

interface EnabledComparisonContext {
  readonly actualImagePath: string;
  readonly outputResultPath: string;
  readonly artifactsEnabled: true;
  readonly expectedImagePath: string;
  readonly diffImagePath: string;
  readonly metadataJsonPath: string;
  readonly ocrInputImagePath: string;
  readonly resolved: ResolvedDefaults;
}

interface DisabledComparisonContext {
  readonly artifactsEnabled: false;
}

type ComparisonContext = EnabledComparisonContext | DisabledComparisonContext;

interface DecodedPng {
  readonly data: Buffer;
  readonly height: number;
  readonly width: number;
}

interface LoadedExpectedImage {
  readonly data: Buffer;
  readonly source: 'buffer' | 'path' | 'file-url';
  readonly sourcePath: string | undefined;
}

interface PreparedComparison {
  readonly actualData: Uint8Array;
  readonly expectedData: Uint8Array;
  readonly height: number;
  readonly totalPixels: number;
  readonly width: number;
}

interface ResolvedLookSimilarOptions {
  readonly maxDiffPixels: number | undefined;
  readonly maxDiffRatio: number;
  readonly threshold: number;
}

interface ResolvedSimilarityOptions {
  readonly minSimilarity: number;
}

interface ResolvedOcrOptions {
  readonly pageSegmentationModes: readonly GtkCaptureOcrPageSegmentationMode[];
  readonly parameters: Readonly<Record<string, string>>;
  readonly preprocess: Required<GtkCaptureOcrPreprocessOptions>;
  readonly region: GtkCapturePixelRegion;
}

interface PreparedOcrImage {
  readonly image: Buffer;
  readonly preprocess: Required<GtkCaptureOcrPreprocessOptions>;
  readonly region: GtkCapturePixelRegion;
}

interface LoadedTesseractModule {
  readonly createWorker: (
    languages?: string | readonly string[],
    oem?: number,
    options?: Partial<TesseractWorkerOptions>
  ) => Promise<TesseractWorker>;
}

interface TesseractWorkerOptions {
  cacheMethod: string;
  cachePath: string;
  corePath: string;
  gzip: boolean;
  langPath: string;
  logger: (message: unknown) => void;
  workerPath: string;
}

interface TesseractWorker {
  readonly recognize: (image: Buffer) => Promise<{
    readonly data: {
      readonly confidence: number;
      readonly text: string;
    };
  }>;
  readonly setParameters: (
    parameters: Readonly<Record<string, string>>
  ) => Promise<unknown>;
  readonly terminate: () => Promise<unknown>;
}

interface OcrWorkerController {
  readonly recognize: (
    preparedImage: PreparedOcrImage,
    options: ResolvedOcrOptions
  ) => Promise<readonly GtkCaptureOcrAttempt[]>;
  readonly release: () => Promise<void>;
}

interface OcrTextData {
  readonly actualImagePath: string | undefined;
  readonly attempts: readonly GtkCaptureOcrAttempt[];
  readonly confidence: number;
  readonly metadataJsonPath: string | undefined;
  readonly normalizedText: string;
  readonly ocrInputImagePath: string | undefined;
  readonly outputResultPath: string | undefined;
  readonly pageSegmentationMode: GtkCaptureOcrPageSegmentationMode;
  readonly text: string;
}

const padNumber = (value: number, width: number): string =>
  value.toString().padStart(width, '0');

const hashText = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 10);

const defaultOcrPageSegmentationModes = [
  'singleBlock',
  'sparseText',
  'singleLine',
  'singleWord',
] as const satisfies readonly GtkCaptureOcrPageSegmentationMode[];

const pageSegmentationModeValues: Record<
  GtkCaptureOcrPageSegmentationMode,
  string
> = {
  auto: '3',
  autoOnly: '2',
  autoOsd: '1',
  circleWord: '9',
  osdOnly: '0',
  rawLine: '13',
  singleBlock: '6',
  singleBlockVerticalText: '5',
  singleChar: '10',
  singleColumn: '4',
  singleLine: '7',
  singleWord: '8',
  sparseText: '11',
  sparseTextOsd: '12',
};

let tesseractModulePromise: Promise<LoadedTesseractModule> | undefined;

const loadTesseractModule = async (): Promise<LoadedTesseractModule> => {
  tesseractModulePromise ??= import('tesseract.js').then((loaded) => {
    const module = loaded as unknown as
      | LoadedTesseractModule
      | { readonly default: LoadedTesseractModule };
    return 'default' in module ? module.default : module;
  });
  return tesseractModulePromise;
};

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
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 129)}-${hashText(normalized)}`;
};

const serializeBounds = (
  bounds: GtkCaptureBounds
): Record<keyof GtkCaptureBounds, number> => ({
  height: bounds.height,
  width: bounds.width,
  x: bounds.x,
  y: bounds.y,
});

const resolveDefaults = (
  defaults: GtkCaptureVisualDefaults,
  options: GtkCaptureResultOutputOptions | undefined
): ResolvedDefaults | undefined => {
  const outputResultPath =
    options?.outputResultPath ??
    defaults.outputResultPath ??
    process.env.GESTAMENT_VISUAL_OUTPUT_RESULT_PATH;
  if (outputResultPath === undefined) {
    return undefined;
  }

  return {
    outputResultPath: resolve(outputResultPath),
    variant:
      options?.variant ??
      defaults.variant ??
      process.env.GESTAMENT_VISUAL_VARIANT ??
      process.env.GESTAMENT_TEST_BACKEND ??
      'default',
  };
};

const loadExpectedImage = async (
  expectedImage: GtkCaptureExpectedImage
): Promise<LoadedExpectedImage> => {
  if (Buffer.isBuffer(expectedImage)) {
    return {
      data: expectedImage,
      source: 'buffer',
      sourcePath: undefined,
    };
  }

  if (typeof expectedImage === 'string') {
    const sourcePath = resolve(expectedImage);
    return {
      data: await readFile(sourcePath),
      source: 'path',
      sourcePath,
    };
  }

  if (expectedImage.protocol !== 'file:') {
    throw new TypeError('expectedImage URL must use the file: protocol.');
  }

  const sourcePath = fileURLToPath(expectedImage);
  return {
    data: await readFile(sourcePath),
    source: 'file-url',
    sourcePath,
  };
};

const decodePng = (image: Buffer): DecodedPng => {
  const png = PNG.sync.read(image);
  return {
    data: png.data,
    height: png.height,
    width: png.width,
  };
};

const validateCaptureImage = (capture: GtkCapture, png: DecodedPng): void => {
  if (
    png.width !== capture.visibleBounds.width ||
    png.height !== capture.visibleBounds.height
  ) {
    throw new Error(
      `Capture PNG size ${png.width}x${png.height} does not match visible bounds ${capture.visibleBounds.width}x${capture.visibleBounds.height}.`
    );
  }
};

const validateFiniteInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer.`);
  }
};

const validateRegion = (
  region: GtkCapturePixelRegion,
  imageWidth: number,
  imageHeight: number,
  label: string
): void => {
  validateFiniteInteger(region.x, `${label}.x`);
  validateFiniteInteger(region.y, `${label}.y`);
  validateFiniteInteger(region.width, `${label}.width`);
  validateFiniteInteger(region.height, `${label}.height`);
  if (region.x < 0 || region.y < 0) {
    throw new TypeError(`${label} origin must be inside the capture image.`);
  }
  if (region.width <= 0 || region.height <= 0) {
    throw new TypeError(`${label} size must be positive.`);
  }
  if (
    region.x + region.width > imageWidth ||
    region.y + region.height > imageHeight
  ) {
    throw new TypeError(`${label} must be inside the capture image.`);
  }
};

const validateRatio = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a number from 0 to 1.`);
  }
};

const validateNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
};

const getComparisonRegion = (
  options: GtkCaptureVisualComparisonOptions | undefined,
  imageWidth: number,
  imageHeight: number
): GtkCapturePixelRegion => {
  const region =
    options?.region ??
    ({ height: imageHeight, width: imageWidth, x: 0, y: 0 } as const);
  validateRegion(region, imageWidth, imageHeight, 'region');
  return region;
};

const validateMasks = (
  masks: readonly GtkCapturePixelRegion[] | undefined,
  imageWidth: number,
  imageHeight: number
): void => {
  if (masks === undefined) {
    return;
  }
  for (const [index, mask] of masks.entries()) {
    validateRegion(mask, imageWidth, imageHeight, `masks[${index}]`);
  }
};

const copyRegionData = (
  source: DecodedPng,
  region: GtkCapturePixelRegion
): Uint8Array => {
  const data = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const sourceStart = ((region.y + y) * source.width + region.x) * 4;
    const sourceEnd = sourceStart + region.width * 4;
    const targetStart = y * region.width * 4;
    data.set(source.data.subarray(sourceStart, sourceEnd), targetStart);
  }
  return data;
};

const applyMasks = (
  actualData: Uint8Array,
  expectedData: Uint8Array,
  region: GtkCapturePixelRegion,
  masks: readonly GtkCapturePixelRegion[] | undefined
): void => {
  if (masks === undefined) {
    return;
  }
  for (const mask of masks) {
    const left = Math.max(region.x, mask.x);
    const top = Math.max(region.y, mask.y);
    const right = Math.min(region.x + region.width, mask.x + mask.width);
    const bottom = Math.min(region.y + region.height, mask.y + mask.height);
    if (left >= right || top >= bottom) {
      continue;
    }
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = ((y - region.y) * region.width + (x - region.x)) * 4;
        actualData[index] = 0;
        actualData[index + 1] = 0;
        actualData[index + 2] = 0;
        actualData[index + 3] = 0;
        expectedData[index] = 0;
        expectedData[index + 1] = 0;
        expectedData[index + 2] = 0;
        expectedData[index + 3] = 0;
      }
    }
  }
};

const prepareComparison = (
  actualPng: DecodedPng,
  expectedPng: DecodedPng,
  options: GtkCaptureVisualComparisonOptions | undefined
): PreparedComparison => {
  if (
    actualPng.width !== expectedPng.width ||
    actualPng.height !== expectedPng.height
  ) {
    throw new Error(
      `Expected image size ${expectedPng.width}x${expectedPng.height} does not match actual capture size ${actualPng.width}x${actualPng.height}.`
    );
  }

  const region = getComparisonRegion(
    options,
    actualPng.width,
    actualPng.height
  );
  validateMasks(options?.masks, actualPng.width, actualPng.height);

  const actualData = copyRegionData(actualPng, region);
  const expectedData = copyRegionData(expectedPng, region);
  applyMasks(actualData, expectedData, region, options?.masks);

  return {
    actualData,
    expectedData,
    height: region.height,
    totalPixels: region.width * region.height,
    width: region.width,
  };
};

const createDiffPng = (
  comparison: PreparedComparison,
  threshold: number
): {
  readonly diffPixels: number;
  readonly diffPng: PNG;
} => {
  const diffPng = new PNG({
    height: comparison.height,
    width: comparison.width,
  });
  const diffPixels = pixelmatch(
    comparison.expectedData,
    comparison.actualData,
    diffPng.data,
    comparison.width,
    comparison.height,
    { threshold }
  );
  return {
    diffPixels,
    diffPng,
  };
};

const createContext = async (
  defaults: GtkCaptureVisualDefaults,
  options: GtkCaptureResultOutputOptions | undefined,
  name: string,
  counter: number
): Promise<ComparisonContext> => {
  const resolved = resolveDefaults(defaults, options);
  if (resolved === undefined) {
    return {
      artifactsEnabled: false,
    };
  }

  const safeVariant = normalizePathSegment(resolved.variant, 'default');
  const safeName = normalizePathSegment(name, 'capture');
  const outputResultPath = join(
    resolved.outputResultPath,
    safeVariant,
    `${safeName}-${padNumber(counter, 6)}`
  );
  await mkdir(outputResultPath, { recursive: true });
  return {
    actualImagePath: join(outputResultPath, 'actual.png'),
    outputResultPath,
    artifactsEnabled: true,
    diffImagePath: join(outputResultPath, 'diff.png'),
    expectedImagePath: join(outputResultPath, 'expected.png'),
    metadataJsonPath: join(outputResultPath, 'metadata.json'),
    ocrInputImagePath: join(outputResultPath, 'ocr-input.png'),
    resolved,
  };
};

const writeMetadata = async (
  context: EnabledComparisonContext,
  capture: GtkCapture,
  name: string,
  matcher: string,
  options: GtkCaptureVisualComparisonOptions | undefined,
  expectedImage: LoadedExpectedImage
): Promise<void> => {
  await writeFile(
    context.metadataJsonPath,
    `${JSON.stringify(
      {
        bounds: serializeBounds(capture.bounds),
        clipped: capture.clipped,
        expectedImageSource: expectedImage.source,
        expectedImageSourcePath: expectedImage.sourcePath,
        imageBytes: capture.image.length,
        matcher,
        masks: options?.masks,
        name,
        region: options?.region,
        variant: context.resolved.variant,
        visibleBounds: serializeBounds(capture.visibleBounds),
      },
      undefined,
      2
    )}\n`
  );
};

const createVisualError = <Result extends GtkCaptureVisualResult>(
  message: string,
  result: Result
): GtkCaptureVisualError<Result> =>
  Object.assign(new Error(message), {
    result,
  });

const saveActualAndMetadata = async (
  context: ComparisonContext,
  capture: GtkCapture,
  name: string,
  matcher: string,
  options: GtkCaptureVisualComparisonOptions | undefined,
  expectedImage: LoadedExpectedImage
): Promise<void> => {
  if (!context.artifactsEnabled) {
    return;
  }

  await writeFile(context.actualImagePath, capture.image);
  await writeMetadata(context, capture, name, matcher, options, expectedImage);
};

const buildBaseResult = (
  context: ComparisonContext
): GtkCaptureVisualResult => {
  if (!context.artifactsEnabled) {
    return {
      pass: true,
    };
  }

  return {
    actualImagePath: context.actualImagePath,
    outputResultPath: context.outputResultPath,
    metadataJsonPath: context.metadataJsonPath,
    pass: true,
  };
};

const writeFailureArtifacts = async (
  context: ComparisonContext,
  expectedImage: Buffer,
  diffPng: PNG
): Promise<
  Pick<GtkCaptureVisualResult, 'diffImagePath' | 'expectedImagePath'>
> => {
  if (!context.artifactsEnabled) {
    return {};
  }

  await writeFile(context.expectedImagePath, expectedImage);
  await writeFile(context.diffImagePath, PNG.sync.write(diffPng));
  return {
    diffImagePath: context.diffImagePath,
    expectedImagePath: context.expectedImagePath,
  };
};

const isLookSimilarPass = (
  diffPixels: number,
  diffRatio: number,
  options: ResolvedLookSimilarOptions
): boolean => {
  const ratioPass = diffRatio <= options.maxDiffRatio;
  const pixelsPass =
    options.maxDiffPixels === undefined || diffPixels <= options.maxDiffPixels;
  return ratioPass && pixelsPass;
};

const resolveLookSimilarOptions = (
  options: GtkCaptureLookSimilarOptions | undefined
): ResolvedLookSimilarOptions => {
  const resolved = {
    maxDiffPixels: options?.maxDiffPixels,
    maxDiffRatio: options?.maxDiffRatio ?? 0.01,
    threshold: options?.threshold ?? 0.1,
  };
  validateRatio(resolved.threshold, 'threshold');
  validateRatio(resolved.maxDiffRatio, 'maxDiffRatio');
  if (resolved.maxDiffPixels !== undefined) {
    validateNonNegativeInteger(resolved.maxDiffPixels, 'maxDiffPixels');
  }
  return resolved;
};

const resolveSimilarityOptions = (
  options: GtkCaptureSimilarityOptions | undefined
): ResolvedSimilarityOptions => {
  const resolved = {
    minSimilarity: options?.minSimilarity ?? 0.985,
  };
  validateRatio(resolved.minSimilarity, 'minSimilarity');
  return resolved;
};

const validateOcrPageSegmentationMode = (
  value: GtkCaptureOcrPageSegmentationMode,
  label: string
): void => {
  if (!(value in pageSegmentationModeValues)) {
    throw new TypeError(
      `${label} must be a supported OCR page segmentation mode.`
    );
  }
};

const validateThreshold = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError(`${label} must be an integer from 0 to 255.`);
  }
};

const validatePositiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const resolveOcrPreprocessOptions = (
  options: GtkCaptureOcrPreprocessOptions | undefined
): Required<GtkCaptureOcrPreprocessOptions> => {
  const resolved = {
    grayscale: options?.grayscale ?? false,
    invert: options?.invert ?? false,
    scale: options?.scale ?? 1,
    threshold: options?.threshold ?? -1,
  };
  validatePositiveInteger(resolved.scale, 'preprocess.scale');
  if (resolved.threshold !== -1) {
    validateThreshold(resolved.threshold, 'preprocess.threshold');
  }
  return resolved;
};

const resolveOcrOptions = (
  options: GtkCaptureOcrOptions | undefined,
  imageWidth: number,
  imageHeight: number
): ResolvedOcrOptions => {
  const pageSegmentationModes =
    options?.pageSegmentationModes ?? defaultOcrPageSegmentationModes;
  if (pageSegmentationModes.length === 0) {
    throw new TypeError('pageSegmentationModes must not be empty.');
  }
  for (const [index, mode] of pageSegmentationModes.entries()) {
    validateOcrPageSegmentationMode(mode, `pageSegmentationModes[${index}]`);
  }
  const region =
    options?.region ??
    ({ height: imageHeight, width: imageWidth, x: 0, y: 0 } as const);
  validateRegion(region, imageWidth, imageHeight, 'region');
  return {
    pageSegmentationModes,
    parameters: options?.parameters ?? {},
    preprocess: resolveOcrPreprocessOptions(options?.preprocess),
    region,
  };
};

const hasOcrPreprocessing = (
  options: Required<GtkCaptureOcrPreprocessOptions>,
  region: GtkCapturePixelRegion,
  imageWidth: number,
  imageHeight: number
): boolean =>
  options.grayscale ||
  options.invert ||
  options.scale !== 1 ||
  options.threshold !== -1 ||
  region.x !== 0 ||
  region.y !== 0 ||
  region.width !== imageWidth ||
  region.height !== imageHeight;

const getLuminance = (red: number, green: number, blue: number): number =>
  Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);

const prepareOcrImage = (
  originalImage: Buffer,
  png: DecodedPng,
  options: ResolvedOcrOptions
): PreparedOcrImage => {
  if (
    !hasOcrPreprocessing(
      options.preprocess,
      options.region,
      png.width,
      png.height
    )
  ) {
    return {
      image: originalImage,
      preprocess: options.preprocess,
      region: options.region,
    };
  }

  const output = new PNG({
    height: options.region.height * options.preprocess.scale,
    width: options.region.width * options.preprocess.scale,
  });
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const sourceX =
        options.region.x + Math.floor(x / options.preprocess.scale);
      const sourceY =
        options.region.y + Math.floor(y / options.preprocess.scale);
      const sourceIndex = (sourceY * png.width + sourceX) * 4;
      const targetIndex = (y * output.width + x) * 4;
      const red = png.data[sourceIndex]!;
      const green = png.data[sourceIndex + 1]!;
      const blue = png.data[sourceIndex + 2]!;
      const alpha = png.data[sourceIndex + 3]!;
      const luminance = getLuminance(red, green, blue);
      const thresholded =
        options.preprocess.threshold === -1
          ? luminance
          : luminance >= options.preprocess.threshold
            ? 255
            : 0;
      const value =
        options.preprocess.grayscale || options.preprocess.threshold !== -1
          ? thresholded
          : undefined;
      output.data[targetIndex] = options.preprocess.invert
        ? 255 - (value ?? red)
        : (value ?? red);
      output.data[targetIndex + 1] = options.preprocess.invert
        ? 255 - (value ?? green)
        : (value ?? green);
      output.data[targetIndex + 2] = options.preprocess.invert
        ? 255 - (value ?? blue)
        : (value ?? blue);
      output.data[targetIndex + 3] = alpha;
    }
  }

  return {
    image: PNG.sync.write(output),
    preprocess: options.preprocess,
    region: options.region,
  };
};

const isEnglishOnlyLanguage = (
  languages: string | readonly string[] | undefined
): boolean => {
  if (languages === undefined) {
    return true;
  }
  if (typeof languages === 'string') {
    return languages === 'eng';
  }
  return languages.length === 1 && languages[0] === 'eng';
};

const resolveOcrWorkerOptions = (
  defaults: GtkCaptureOcrDefaults | undefined
): {
  readonly languages: string | readonly string[];
  readonly options: Partial<TesseractWorkerOptions>;
} => {
  const languages =
    defaults?.languages === undefined
      ? englishLanguageData.code
      : typeof defaults.languages === 'string'
        ? defaults.languages
        : [...defaults.languages];
  const useBundledEnglishData =
    defaults?.langPath === undefined && isEnglishOnlyLanguage(languages);
  const workerOptions: Partial<TesseractWorkerOptions> = {
    logger: () => undefined,
  };
  if (defaults?.cachePath !== undefined) {
    workerOptions.cachePath = defaults.cachePath;
  }
  if (defaults?.corePath !== undefined) {
    workerOptions.corePath = defaults.corePath;
  }
  if (defaults?.workerPath !== undefined) {
    workerOptions.workerPath = defaults.workerPath;
  }
  if (defaults?.langPath !== undefined) {
    workerOptions.langPath = defaults.langPath;
  } else if (useBundledEnglishData) {
    workerOptions.langPath = englishLanguageData.langPath;
  }
  if (defaults?.gzip !== undefined) {
    workerOptions.gzip = defaults.gzip;
  } else if (useBundledEnglishData) {
    workerOptions.gzip = englishLanguageData.gzip;
  }
  if (defaults?.cacheMethod !== undefined) {
    workerOptions.cacheMethod = defaults.cacheMethod;
  } else if (useBundledEnglishData) {
    workerOptions.cacheMethod = 'none';
  }
  return {
    languages,
    options: workerOptions,
  };
};

const createOcrWorker = async (
  defaults: GtkCaptureOcrDefaults | undefined
): Promise<TesseractWorker> => {
  const tesseract = await loadTesseractModule();
  const resolved = resolveOcrWorkerOptions(defaults);
  return await tesseract.createWorker(
    resolved.languages,
    undefined,
    resolved.options
  );
};

const recognizeWithWorker = async (
  worker: TesseractWorker,
  preparedImage: PreparedOcrImage,
  options: ResolvedOcrOptions
): Promise<readonly GtkCaptureOcrAttempt[]> => {
  const attempts: GtkCaptureOcrAttempt[] = [];
  for (const pageSegmentationMode of options.pageSegmentationModes) {
    await worker.setParameters({
      ...options.parameters,
      tessedit_pageseg_mode: pageSegmentationModeValues[pageSegmentationMode],
    });
    const recognized = await worker.recognize(preparedImage.image);
    attempts.push({
      confidence: Number.isFinite(recognized.data.confidence)
        ? recognized.data.confidence
        : 0,
      normalizedText: normalizeWhitespace(recognized.data.text),
      pageSegmentationMode,
      text: recognized.data.text,
    });
  }
  return attempts;
};

const createOcrWorkerController = (
  defaults: GtkCaptureOcrDefaults | undefined
): OcrWorkerController => {
  if (defaults?.workerMode !== 'shared') {
    return {
      recognize: async (
        preparedImage: PreparedOcrImage,
        options: ResolvedOcrOptions
      ): Promise<readonly GtkCaptureOcrAttempt[]> => {
        const worker = await createOcrWorker(defaults);
        try {
          return await recognizeWithWorker(worker, preparedImage, options);
        } finally {
          await worker.terminate();
        }
      },
      release: async (): Promise<void> => undefined,
    };
  }

  let workerPromise: Promise<TesseractWorker> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const getWorker = (): Promise<TesseractWorker> => {
    workerPromise ??= createOcrWorker(defaults);
    return workerPromise;
  };
  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = queue;
    let resolveNext: () => void = () => undefined;
    queue = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      resolveNext();
    }
  };

  return {
    recognize: async (
      preparedImage: PreparedOcrImage,
      options: ResolvedOcrOptions
    ): Promise<readonly GtkCaptureOcrAttempt[]> =>
      await enqueue(async () =>
        recognizeWithWorker(await getWorker(), preparedImage, options)
      ),
    release: async (): Promise<void> => {
      await queue;
      if (workerPromise === undefined) {
        return;
      }
      const worker = await workerPromise;
      workerPromise = undefined;
      await worker.terminate();
    },
  };
};

const validateConfidence = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`${label} must be a number from 0 to 100.`);
  }
};

const formatExpectedText = (expected: string | RegExp): string =>
  typeof expected === 'string' ? expected : expected.toString();

const serializeExpectedText = (
  expected: string | RegExp | undefined
):
  | {
      readonly type: 'string';
      readonly value: string;
    }
  | {
      readonly flags: string;
      readonly source: string;
      readonly type: 'regexp';
    }
  | undefined => {
  if (expected === undefined) {
    return undefined;
  }
  if (typeof expected === 'string') {
    return {
      type: 'string',
      value: expected,
    };
  }
  return {
    flags: expected.flags,
    source: expected.source,
    type: 'regexp',
  };
};

const selectBestOcrAttempt = (
  attempts: readonly GtkCaptureOcrAttempt[]
): GtkCaptureOcrAttempt => {
  const [firstAttempt] = attempts;
  if (firstAttempt === undefined) {
    throw new Error('OCR did not return any recognition attempts.');
  }
  return attempts.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  );
};

const createOcrTextData = (
  context: ComparisonContext,
  attempts: readonly GtkCaptureOcrAttempt[]
): OcrTextData => {
  const bestAttempt = selectBestOcrAttempt(attempts);
  if (!context.artifactsEnabled) {
    return {
      actualImagePath: undefined,
      attempts,
      confidence: bestAttempt.confidence,
      metadataJsonPath: undefined,
      normalizedText: bestAttempt.normalizedText,
      ocrInputImagePath: undefined,
      outputResultPath: undefined,
      pageSegmentationMode: bestAttempt.pageSegmentationMode,
      text: bestAttempt.text,
    };
  }
  return {
    actualImagePath: context.actualImagePath,
    attempts,
    confidence: bestAttempt.confidence,
    metadataJsonPath: context.metadataJsonPath,
    normalizedText: bestAttempt.normalizedText,
    ocrInputImagePath: context.ocrInputImagePath,
    outputResultPath: context.outputResultPath,
    pageSegmentationMode: bestAttempt.pageSegmentationMode,
    text: bestAttempt.text,
  };
};

const writeOcrMetadata = async (
  context: EnabledComparisonContext,
  capture: GtkCapture,
  name: string,
  matcher: string,
  options: GtkCaptureOcrOptions | undefined,
  preparedImage: PreparedOcrImage,
  attempts: readonly GtkCaptureOcrAttempt[],
  expected: string | RegExp | undefined
): Promise<void> => {
  await writeFile(
    context.metadataJsonPath,
    `${JSON.stringify(
      {
        attempts,
        bounds: serializeBounds(capture.bounds),
        clipped: capture.clipped,
        expectedText: serializeExpectedText(expected),
        imageBytes: capture.image.length,
        matcher,
        name,
        ocrInputBytes: preparedImage.image.length,
        pageSegmentationModes: options?.pageSegmentationModes,
        parameters: options?.parameters,
        preprocess: preparedImage.preprocess,
        region: preparedImage.region,
        variant: context.resolved.variant,
        visibleBounds: serializeBounds(capture.visibleBounds),
      },
      undefined,
      2
    )}\n`
  );
};

const saveOcrArtifactsAndMetadata = async (
  context: ComparisonContext,
  capture: GtkCapture,
  name: string,
  matcher: string,
  options: GtkCaptureOcrOptions | undefined,
  preparedImage: PreparedOcrImage,
  attempts: readonly GtkCaptureOcrAttempt[],
  expected: string | RegExp | undefined
): Promise<void> => {
  if (!context.artifactsEnabled) {
    return;
  }

  await writeFile(context.actualImagePath, capture.image);
  await writeFile(context.ocrInputImagePath, preparedImage.image);
  await writeOcrMetadata(
    context,
    capture,
    name,
    matcher,
    options,
    preparedImage,
    attempts,
    expected
  );
};

const matchOcrAttempt = (
  attempt: GtkCaptureOcrAttempt,
  expected: string | RegExp,
  options: GtkCaptureOcrTextAssertionOptions | undefined
): boolean => {
  const normalize = options?.normalizeWhitespace ?? true;
  const candidate = normalize ? attempt.normalizedText : attempt.text;
  const minConfidence = options?.minConfidence;
  if (minConfidence !== undefined) {
    validateConfidence(minConfidence, 'minConfidence');
    if (attempt.confidence < minConfidence) {
      return false;
    }
  }

  if (typeof expected === 'string') {
    if (expected.length === 0) {
      throw new TypeError('expected text must not be empty.');
    }
    const expectedText = normalize ? normalizeWhitespace(expected) : expected;
    if (expectedText.length === 0) {
      throw new TypeError(
        'expected text must not be empty after normalization.'
      );
    }
    if (options?.caseSensitive ?? false) {
      return candidate.includes(expectedText);
    }
    return candidate
      .toLocaleLowerCase()
      .includes(expectedText.toLocaleLowerCase());
  }

  expected.lastIndex = 0;
  const matched = expected.test(candidate);
  expected.lastIndex = 0;
  return matched;
};

const createOcrResult = (
  data: OcrTextData,
  expected: string | RegExp,
  pass: boolean,
  selectedAttempt: GtkCaptureOcrAttempt
): GtkCaptureOcrResult => {
  const artifactPaths =
    data.outputResultPath === undefined
      ? {}
      : {
          actualImagePath: data.actualImagePath!,
          metadataJsonPath: data.metadataJsonPath!,
          ocrInputImagePath: data.ocrInputImagePath!,
          outputResultPath: data.outputResultPath,
        };
  return {
    ...artifactPaths,
    attempts: data.attempts,
    confidence: selectedAttempt.confidence,
    expectedText: formatExpectedText(expected),
    normalizedText: selectedAttempt.normalizedText,
    pageSegmentationMode: selectedAttempt.pageSegmentationMode,
    pass,
    text: selectedAttempt.text,
  };
};

const assertOcrText = async (
  data: OcrTextData,
  expected: string | RegExp,
  options: GtkCaptureOcrTextAssertionOptions | undefined
): Promise<GtkCaptureOcrResult> => {
  const matchedAttempt = data.attempts.find((attempt) =>
    matchOcrAttempt(attempt, expected, options)
  );
  if (matchedAttempt !== undefined) {
    return createOcrResult(data, expected, true, matchedAttempt);
  }

  const bestAttempt = selectBestOcrAttempt(data.attempts);
  const failedResult = createOcrResult(data, expected, false, bestAttempt);
  throw createVisualError(
    `Capture OCR text did not contain ${formatExpectedText(
      expected
    )}. Recognized text: ${JSON.stringify(bestAttempt.normalizedText)}.`,
    failedResult
  );
};

const createOcrText = (data: OcrTextData): GtkCaptureOcrText => {
  const artifactPaths =
    data.outputResultPath === undefined
      ? {}
      : {
          actualImagePath: data.actualImagePath!,
          metadataJsonPath: data.metadataJsonPath!,
          ocrInputImagePath: data.ocrInputImagePath!,
          outputResultPath: data.outputResultPath,
        };
  return {
    ...artifactPaths,
    attempts: data.attempts,
    confidence: data.confidence,
    normalizedText: data.normalizedText,
    pageSegmentationMode: data.pageSegmentationMode,
    text: data.text,
    toContainText: async (
      expected: string | RegExp,
      options?: GtkCaptureOcrTextAssertionOptions
    ): Promise<GtkCaptureOcrResult> =>
      await assertOcrText(data, expected, options),
  };
};

const readCaptureText = async (
  defaults: GtkCaptureVisualDefaults,
  nextCounter: () => number,
  workerController: OcrWorkerController,
  capture: GtkCapture,
  name: string,
  matcher: string,
  options: GtkCaptureOcrOptions | undefined,
  expected: string | RegExp | undefined
): Promise<GtkCaptureOcrText> => {
  const context = await createContext(defaults, options, name, nextCounter());
  const actualPng = decodePng(capture.image);
  validateCaptureImage(capture, actualPng);
  const ocrOptions = resolveOcrOptions(
    options,
    actualPng.width,
    actualPng.height
  );
  const preparedImage = prepareOcrImage(capture.image, actualPng, ocrOptions);
  const attempts = await workerController.recognize(preparedImage, ocrOptions);
  await saveOcrArtifactsAndMetadata(
    context,
    capture,
    name,
    matcher,
    options,
    preparedImage,
    attempts,
    expected
  );
  return createOcrText(createOcrTextData(context, attempts));
};

const createLookSimilarAssertion = (
  defaults: GtkCaptureVisualDefaults,
  nextCounter: () => number,
  capture: GtkCapture,
  name: string
): ((
  expectedImage: GtkCaptureExpectedImage,
  options?: GtkCaptureLookSimilarOptions
) => Promise<GtkCaptureLookSimilarResult>) => {
  const toLookSimilar = async (
    expectedImage: GtkCaptureExpectedImage,
    options?: GtkCaptureLookSimilarOptions
  ): Promise<GtkCaptureLookSimilarResult> => {
    const context = await createContext(defaults, options, name, nextCounter());
    const actualPng = decodePng(capture.image);
    validateCaptureImage(capture, actualPng);
    const loadedExpectedImage = await loadExpectedImage(expectedImage);
    const expectedPng = decodePng(loadedExpectedImage.data);
    await saveActualAndMetadata(
      context,
      capture,
      name,
      'toLookSimilar',
      options,
      loadedExpectedImage
    );

    const comparisonOptions = resolveLookSimilarOptions(options);
    const comparison = prepareComparison(actualPng, expectedPng, options);
    const { diffPixels, diffPng } = createDiffPng(
      comparison,
      comparisonOptions.threshold
    );
    const diffRatio = diffPixels / comparison.totalPixels;
    const result: GtkCaptureLookSimilarResult = {
      ...buildBaseResult(context),
      diffPixels,
      diffRatio,
      totalPixels: comparison.totalPixels,
    };

    if (isLookSimilarPass(diffPixels, diffRatio, comparisonOptions)) {
      return result;
    }

    const failureArtifacts = await writeFailureArtifacts(
      context,
      loadedExpectedImage.data,
      diffPng
    );
    const failedResult: GtkCaptureLookSimilarResult = {
      ...result,
      ...failureArtifacts,
      pass: false,
    };
    throw createVisualError(
      `Capture image differs: ${diffPixels} pixels (${diffRatio.toFixed(
        6
      )}) exceeded maxDiffRatio ${comparisonOptions.maxDiffRatio}${
        comparisonOptions.maxDiffPixels === undefined
          ? ''
          : ` and maxDiffPixels ${comparisonOptions.maxDiffPixels}`
      }.`,
      failedResult
    );
  };
  return toLookSimilar;
};

const createSimilarityAssertion = (
  defaults: GtkCaptureVisualDefaults,
  nextCounter: () => number,
  capture: GtkCapture,
  name: string
): ((
  expectedImage: GtkCaptureExpectedImage,
  options?: GtkCaptureSimilarityOptions
) => Promise<GtkCaptureSimilarityResult>) => {
  const toHaveSimilarity = async (
    expectedImage: GtkCaptureExpectedImage,
    options?: GtkCaptureSimilarityOptions
  ): Promise<GtkCaptureSimilarityResult> => {
    const context = await createContext(defaults, options, name, nextCounter());
    const actualPng = decodePng(capture.image);
    validateCaptureImage(capture, actualPng);
    const loadedExpectedImage = await loadExpectedImage(expectedImage);
    const expectedPng = decodePng(loadedExpectedImage.data);
    await saveActualAndMetadata(
      context,
      capture,
      name,
      'toHaveSimilarity',
      options,
      loadedExpectedImage
    );

    const comparisonOptions = resolveSimilarityOptions(options);
    const comparison = prepareComparison(actualPng, expectedPng, options);
    const similarity = ssim(
      {
        data: new Uint8ClampedArray(comparison.expectedData),
        height: comparison.height,
        width: comparison.width,
      },
      {
        data: new Uint8ClampedArray(comparison.actualData),
        height: comparison.height,
        width: comparison.width,
      }
    ).mssim;
    const { diffPixels, diffPng } = createDiffPng(comparison, 0.1);
    const diffRatio = diffPixels / comparison.totalPixels;
    const result: GtkCaptureSimilarityResult = {
      ...buildBaseResult(context),
      diffPixels,
      diffRatio,
      similarity,
      totalPixels: comparison.totalPixels,
    };

    if (similarity >= comparisonOptions.minSimilarity) {
      return result;
    }

    const failureArtifacts = await writeFailureArtifacts(
      context,
      loadedExpectedImage.data,
      diffPng
    );
    const failedResult: GtkCaptureSimilarityResult = {
      ...result,
      ...failureArtifacts,
      pass: false,
    };
    throw createVisualError(
      `Capture image similarity ${similarity.toFixed(
        6
      )} is below minSimilarity ${comparisonOptions.minSimilarity}.`,
      failedResult
    );
  };
  return toHaveSimilarity;
};

const createReadTextAssertion = (
  defaults: GtkCaptureVisualDefaults,
  nextCounter: () => number,
  workerController: OcrWorkerController,
  capture: GtkCapture,
  name: string
): ((options?: GtkCaptureOcrOptions) => Promise<GtkCaptureOcrText>) => {
  const readText = async (
    options?: GtkCaptureOcrOptions
  ): Promise<GtkCaptureOcrText> =>
    await readCaptureText(
      defaults,
      nextCounter,
      workerController,
      capture,
      name,
      'readText',
      options,
      undefined
    );
  return readText;
};

const createContainTextAssertion = (
  defaults: GtkCaptureVisualDefaults,
  nextCounter: () => number,
  workerController: OcrWorkerController,
  capture: GtkCapture,
  name: string
): ((
  expected: string | RegExp,
  options?: GtkCaptureOcrAssertionOptions
) => Promise<GtkCaptureOcrResult>) => {
  const toContainText = async (
    expected: string | RegExp,
    options?: GtkCaptureOcrAssertionOptions
  ): Promise<GtkCaptureOcrResult> => {
    const ocrText = await readCaptureText(
      defaults,
      nextCounter,
      workerController,
      capture,
      name,
      'toContainText',
      options,
      expected
    );
    return await ocrText.toContainText(expected, options);
  };
  return toContainText;
};

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates GTK capture visual assertion helpers with shared defaults.
 * @param defaults Default artifact and variant settings.
 * @returns GTK capture assertion helper.
 */
export const createGtkCaptureExpect = (
  defaults?: GtkCaptureVisualDefaults
): GtkCaptureExpect => {
  const resolvedDefaults = defaults ?? {};
  const workerController = createOcrWorkerController(resolvedDefaults.ocr);
  let counter = 0;
  const nextCounter = (): number => {
    const value = counter;
    counter += 1;
    return value;
  };
  const release = async (): Promise<void> => {
    await workerController.release();
  };
  const expectCapture = (
    capture: GtkCapture,
    name: string
  ): GtkCaptureExpectation => ({
    readText: createReadTextAssertion(
      resolvedDefaults,
      nextCounter,
      workerController,
      capture,
      name
    ),
    toContainText: createContainTextAssertion(
      resolvedDefaults,
      nextCounter,
      workerController,
      capture,
      name
    ),
    toHaveSimilarity: createSimilarityAssertion(
      resolvedDefaults,
      nextCounter,
      capture,
      name
    ),
    toLookSimilar: createLookSimilarAssertion(
      resolvedDefaults,
      nextCounter,
      capture,
      name
    ),
  });
  return {
    expectCapture,
    release,
    [Symbol.asyncDispose]: release,
  };
};

const defaultGtkCaptureExpect = createGtkCaptureExpect();

/**
 * Creates an assertion object for a captured GTK image.
 * @param capture GTK capture to assert.
 * @param name Artifact name.
 * @returns Assertion object for the capture.
 */
export const expectCapture = (
  capture: GtkCapture,
  name: string
): GtkCaptureExpectation =>
  defaultGtkCaptureExpect.expectCapture(capture, name);
