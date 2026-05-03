// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGtkCaptureExpect,
  expectCapture,
  type GtkCaptureExpect,
  type GtkCaptureExpectation,
  type GtkCaptureExpectedImage,
  type GtkCaptureLookSimilarOptions,
  type GtkCaptureLookSimilarResult,
  type GtkCaptureOcrAssertionOptions,
  type GtkCaptureOcrOptions,
  type GtkCaptureOcrResult,
  type GtkCaptureOcrText,
  type GtkCapturePixelRegion,
  type GtkCaptureSimilarityOptions,
  type GtkCaptureSimilarityResult,
  type GtkCaptureVisualError,
  type GtkCaptureVisualResult,
} from '../src/testing';
import type { GtkCapture, Releasable } from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

type PixelColor = readonly [number, number, number, number];

interface MockTesseractResult {
  readonly confidence: number;
  readonly text: string;
}

interface MockTesseractWorker {
  readonly recognize: ReturnType<typeof vi.fn>;
  readonly setParameters: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
}

const tesseractMock = vi.hoisted(() => {
  const state: {
    readonly createWorker: ReturnType<typeof vi.fn>;
    readonly workers: MockTesseractWorker[];
    results: MockTesseractResult[];
  } = {
    createWorker: vi.fn(),
    results: [],
    workers: [],
  };
  const reset = (): void => {
    state.results = [];
    state.workers.splice(0);
    state.createWorker.mockReset();
    state.createWorker.mockImplementation(async () => {
      const worker: MockTesseractWorker = {
        recognize: vi.fn(async () => {
          const result = state.results.shift() ?? {
            confidence: 91,
            text: 'Submit\n',
          };
          return {
            data: result,
          };
        }),
        setParameters: vi.fn(async () => undefined),
        terminate: vi.fn(async () => undefined),
      };
      state.workers.push(worker);
      return worker;
    });
  };
  reset();
  return {
    reset,
    state,
  };
});

vi.mock('tesseract.js', () => ({
  createWorker: tesseractMock.state.createWorker,
}));

const black4x4ImageUrl = new URL('./images/black-4x4.png', import.meta.url);
const black16x16ImageUrl = new URL('./images/black-16x16.png', import.meta.url);
const black4x4ImagePath = black4x4ImageUrl.pathname;
const black16x16ImagePath = black16x16ImageUrl.pathname;
const originalOutputResultPath =
  process.env.GESTAMENT_VISUAL_OUTPUT_RESULT_PATH;
const originalVariant = process.env.GESTAMENT_VISUAL_VARIANT;
const originalBackend = process.env.GESTAMENT_TEST_BACKEND;
const tempRoots: string[] = [];

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const createTempRoot = async (): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-capture-testing-'));
  tempRoots.push(tempRoot);
  return tempRoot;
};

const createPngBuffer = (
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => PixelColor
): Buffer => {
  const png = new PNG({
    height,
    width,
  });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = pixelAt(x, y);
      const index = (y * width + x) * 4;
      png.data[index] = red;
      png.data[index + 1] = green;
      png.data[index + 2] = blue;
      png.data[index + 3] = alpha;
    }
  }
  return PNG.sync.write(png);
};

const solidPng = (width: number, height: number, color: PixelColor): Buffer =>
  createPngBuffer(width, height, () => color);

const createCapture = (
  image: Buffer,
  width: number,
  height: number
): GtkCapture => ({
  bounds: {
    height,
    width,
    x: 10,
    y: 20,
  },
  clipped: false,
  image,
  visibleBounds: {
    height,
    width,
    x: 10,
    y: 20,
  },
});

const expectVisualError = async <Result extends GtkCaptureVisualResult>(
  operation: () => Promise<Result>
): Promise<GtkCaptureVisualError<Result>> => {
  try {
    await operation();
  } catch (error) {
    expect(error).toHaveProperty('result');
    return error as GtkCaptureVisualError<Result>;
  }
  throw new Error('Expected visual assertion to fail.');
};

afterEach(async () => {
  tesseractMock.reset();
  restoreEnv('GESTAMENT_VISUAL_OUTPUT_RESULT_PATH', originalOutputResultPath);
  restoreEnv('GESTAMENT_VISUAL_VARIANT', originalVariant);
  restoreEnv('GESTAMENT_TEST_BACKEND', originalBackend);

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

describe('GTK capture visual testing', () => {
  it('does not write artifacts when no output result path is specified', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    process.env.GESTAMENT_VISUAL_VARIANT = 'unit-env';
    const gtkExpect = createGtkCaptureExpect();
    const expectedImage = await readFile(black4x4ImagePath);

    const result = await gtkExpect
      .expectCapture(createCapture(expectedImage, 4, 4), 'default')
      .toLookSimilar(expectedImage);
    expect(result).toMatchObject({
      diffPixels: 0,
      diffRatio: 0,
      pass: true,
    });
    expect(result.actualImagePath).toBeUndefined();
    expect(result.outputResultPath).toBeUndefined();
    expect(result.metadataJsonPath).toBeUndefined();

    const differentImage = solidPng(4, 4, [255, 255, 255, 255]);
    const error = await expectVisualError(() =>
      gtkExpect
        .expectCapture(createCapture(differentImage, 4, 4), 'different')
        .toLookSimilar(expectedImage, {
          maxDiffRatio: 0,
          threshold: 0,
          variant: 'ignored',
        })
    );
    expect(error.result.pass).toBe(false);
    expect(error.result.actualImagePath).toBeUndefined();
    expect(error.result.diffImagePath).toBeUndefined();
    expect(error.result.expectedImagePath).toBeUndefined();
    expect(error.result.metadataJsonPath).toBeUndefined();
    await expect(readdir(outputResultPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('accepts expected images from buffers, path strings, and file URLs', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });
    const expected4x4Image = await readFile(black4x4ImagePath);
    const expected16x16Image = await readFile(black16x16ImagePath);

    await expect(
      gtkExpect
        .expectCapture(createCapture(expected4x4Image, 4, 4), 'buffer')
        .toLookSimilar(expected4x4Image)
    ).resolves.toMatchObject({
      diffPixels: 0,
      diffRatio: 0,
      pass: true,
    });

    await expect(
      gtkExpect
        .expectCapture(createCapture(expected4x4Image, 4, 4), 'path')
        .toLookSimilar(black4x4ImagePath)
    ).resolves.toMatchObject({
      diffPixels: 0,
      diffRatio: 0,
      pass: true,
    });

    await expect(
      gtkExpect
        .expectCapture(createCapture(expected16x16Image, 16, 16), 'file-url')
        .toHaveSimilarity(black16x16ImageUrl)
    ).resolves.toMatchObject({
      pass: true,
      similarity: 1,
    });
  });

  it('does not write artifacts when only a variant is specified', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      variant: 'unit',
    });
    const expectedImage = await readFile(black4x4ImagePath);

    const result = await gtkExpect
      .expectCapture(createCapture(expectedImage, 4, 4), 'default-root')
      .toLookSimilar(expectedImage);

    expect(result.actualImagePath).toBeUndefined();
    expect(result.outputResultPath).toBeUndefined();
    expect(result.metadataJsonPath).toBeUndefined();
    await expect(readdir(outputResultPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes artifacts to the environment output result path when specified', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    process.env.GESTAMENT_VISUAL_OUTPUT_RESULT_PATH = outputResultPath;
    const gtkExpect = createGtkCaptureExpect({
      variant: 'unit',
    });
    const expectedImage = await readFile(black4x4ImagePath);

    const result = await gtkExpect
      .expectCapture(createCapture(expectedImage, 4, 4), 'env-root')
      .toLookSimilar(expectedImage);

    expect(result.outputResultPath).toBe(
      join(outputResultPath, 'unit', 'env-root-000000')
    );
    await expect(readFile(result.actualImagePath!)).resolves.toEqual(
      expectedImage
    );
  });

  it('rejects missing expected image paths', async () => {
    const root = await createTempRoot();
    const capture = createCapture(solidPng(3, 2, [255, 255, 255, 255]), 3, 2);
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath: join(root, 'artifacts'),
      variant: 'unit',
    });

    await expect(
      gtkExpect
        .expectCapture(capture, 'missing')
        .toLookSimilar(join(root, 'missing.png'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('compares captures with pixel-difference tolerances', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });
    const expectedImage = await readFile(black4x4ImagePath);

    const exact = await gtkExpect
      .expectCapture(createCapture(expectedImage, 4, 4), 'exact')
      .toLookSimilar(expectedImage);
    expect(exact.diffPixels).toBe(0);
    expect(exact.diffRatio).toBe(0);

    const onePixelDifferent = createPngBuffer(4, 4, (x, y) =>
      x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]
    );
    const within = await gtkExpect
      .expectCapture(createCapture(onePixelDifferent, 4, 4), 'within')
      .toLookSimilar(black4x4ImagePath, {
        maxDiffPixels: 1,
        maxDiffRatio: 0.1,
        threshold: 0.1,
      });
    expect(within.diffPixels).toBe(1);

    const twoPixelsDifferent = createPngBuffer(4, 4, (x, y) =>
      (x === 0 && y === 0) || (x === 1 && y === 0)
        ? [255, 255, 255, 255]
        : [0, 0, 0, 255]
    );
    const error = await expectVisualError(() =>
      gtkExpect
        .expectCapture(createCapture(twoPixelsDifferent, 4, 4), 'exceeded')
        .toLookSimilar(black4x4ImagePath, {
          maxDiffPixels: 1,
          maxDiffRatio: 0.1,
          threshold: 0.1,
        })
    );
    expect(error.result.pass).toBe(false);
    expect(error.result.diffPixels).toBe(2);
    await expect(readFile(error.result.actualImagePath!)).resolves.toEqual(
      twoPixelsDifferent
    );
    await expect(readFile(error.result.expectedImagePath!)).resolves.toEqual(
      expectedImage
    );
    await expect(readFile(error.result.diffImagePath!)).resolves.toBeInstanceOf(
      Buffer
    );
    await expect(
      JSON.parse(await readFile(error.result.metadataJsonPath!, 'utf8'))
    ).toMatchObject({
      expectedImageSource: 'path',
      expectedImageSourcePath: black4x4ImagePath,
      matcher: 'toLookSimilar',
      name: 'exceeded',
      variant: 'unit',
    });
  });

  it('ignores pixels outside a region and inside masks', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });
    const expectedImage = await readFile(black4x4ImagePath);

    const outsideRegionDifferent = createPngBuffer(4, 4, (x, y) =>
      x === 3 && y === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]
    );
    const regionResult = await gtkExpect
      .expectCapture(createCapture(outsideRegionDifferent, 4, 4), 'region')
      .toLookSimilar(expectedImage, {
        maxDiffRatio: 0,
        region: {
          height: 2,
          width: 2,
          x: 0,
          y: 0,
        },
      });
    expect(regionResult.diffPixels).toBe(0);

    const maskedResult = await gtkExpect
      .expectCapture(createCapture(outsideRegionDifferent, 4, 4), 'masked')
      .toLookSimilar(expectedImage, {
        masks: [
          {
            height: 1,
            width: 1,
            x: 3,
            y: 3,
          },
        ],
        maxDiffRatio: 0,
      });
    expect(maskedResult.diffPixels).toBe(0);
  });

  it('compares captures by structural similarity', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });
    const expectedImage = await readFile(black16x16ImagePath);

    const similar = await gtkExpect
      .expectCapture(createCapture(expectedImage, 16, 16), 'similar')
      .toHaveSimilarity(black16x16ImageUrl);
    expect(similar.similarity).toBe(1);

    const differentImage = solidPng(16, 16, [255, 255, 255, 255]);
    const error = await expectVisualError(() =>
      gtkExpect
        .expectCapture(createCapture(differentImage, 16, 16), 'different')
        .toHaveSimilarity(black16x16ImageUrl, {
          minSimilarity: 0.99,
        })
    );
    expect(error.result.pass).toBe(false);
    expect(error.result.similarity).toBeLessThan(0.99);
    await expect(readFile(error.result.expectedImagePath!)).resolves.toEqual(
      expectedImage
    );
    await expect(readFile(error.result.diffImagePath!)).resolves.toBeInstanceOf(
      Buffer
    );
  });

  it('rejects capture PNGs that do not match visible bounds', async () => {
    const root = await createTempRoot();
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath: join(root, 'artifacts'),
      variant: 'unit',
    });
    const capture = createCapture(solidPng(2, 2, [0, 0, 0, 255]), 3, 2);

    await expect(
      gtkExpect
        .expectCapture(capture, 'size-mismatch')
        .toLookSimilar(black4x4ImagePath)
    ).rejects.toThrow('does not match visible bounds');
  });

  it('rejects invalid regions and masks with TypeError', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });
    const image = await readFile(black4x4ImagePath);

    await expect(
      gtkExpect
        .expectCapture(createCapture(image, 4, 4), 'invalid-region')
        .toLookSimilar(black4x4ImagePath, {
          region: {
            height: 1,
            width: 2,
            x: 3,
            y: 0,
          },
        })
    ).rejects.toThrow(TypeError);
    await expect(
      gtkExpect
        .expectCapture(createCapture(image, 4, 4), 'invalid-mask')
        .toHaveSimilarity(black4x4ImagePath, {
          masks: [
            {
              height: 1,
              width: 1,
              x: 4,
              y: 0,
            },
          ],
        })
    ).rejects.toThrow(TypeError);
  });

  it('asserts OCR text with page segmentation fallback', async () => {
    tesseractMock.state.results = [
      {
        confidence: 10,
        text: 'Noise',
      },
      {
        confidence: 88,
        text: 'Submit\n',
      },
    ];
    const capture = createCapture(solidPng(8, 4, [255, 255, 255, 255]), 8, 4);
    const gtkExpect = createGtkCaptureExpect();

    const result = await gtkExpect
      .expectCapture(capture, 'ocr-submit')
      .toContainText('submit', {
        pageSegmentationModes: ['singleWord', 'singleLine'],
      });

    expect(result).toMatchObject({
      confidence: 88,
      expectedText: 'submit',
      normalizedText: 'Submit',
      pageSegmentationMode: 'singleLine',
      pass: true,
    });
    expect(tesseractMock.state.createWorker).toHaveBeenCalledTimes(1);
    expect(tesseractMock.state.workers).toHaveLength(1);
    expect(tesseractMock.state.workers[0]!.setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: '8',
    });
    expect(tesseractMock.state.workers[0]!.setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: '7',
    });
    expect(tesseractMock.state.workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('asserts OCR text with regular expressions and failure diagnostics', async () => {
    tesseractMock.state.results = [
      {
        confidence: 77,
        text: 'Ready',
      },
    ];
    const capture = createCapture(solidPng(8, 4, [255, 255, 255, 255]), 8, 4);
    const gtkExpect = createGtkCaptureExpect();

    await expect(
      gtkExpect.expectCapture(capture, 'ocr-ready').toContainText(/^ready$/i, {
        pageSegmentationModes: ['singleBlock'],
      })
    ).resolves.toMatchObject({
      expectedText: '/^ready$/i',
      pass: true,
    });

    tesseractMock.state.results = [
      {
        confidence: 77,
        text: 'Ready',
      },
    ];
    const error = await expectVisualError(() =>
      gtkExpect.expectCapture(capture, 'ocr-failure').toContainText('Submit', {
        pageSegmentationModes: ['singleBlock'],
      })
    );
    expect(error.result).toMatchObject({
      expectedText: 'Submit',
      normalizedText: 'Ready',
      pass: false,
    });
    expect(error.message).toContain('Recognized text');
  });

  it('reuses read OCR text for multiple assertions without recognizing again', async () => {
    tesseractMock.state.results = [
      {
        confidence: 94,
        text: 'Submit Cancel',
      },
    ];
    const capture = createCapture(solidPng(8, 4, [255, 255, 255, 255]), 8, 4);
    const gtkExpect = createGtkCaptureExpect();

    const ocrText = await gtkExpect
      .expectCapture(capture, 'ocr-dialog')
      .readText({
        pageSegmentationModes: ['singleBlock'],
      });

    await expect(ocrText.toContainText('submit')).resolves.toMatchObject({
      pass: true,
    });
    await expect(ocrText.toContainText(/cancel/i)).resolves.toMatchObject({
      pass: true,
    });
    expect(tesseractMock.state.workers[0]!.recognize).toHaveBeenCalledTimes(1);
  });

  it('writes OCR artifacts and applies preprocessing options', async () => {
    const root = await createTempRoot();
    const outputResultPath = join(root, 'artifacts');
    const sourceImage = createPngBuffer(2, 2, (x, y) =>
      x === 1 && y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    );
    const capture = createCapture(sourceImage, 2, 2);
    const gtkExpect = createGtkCaptureExpect({
      outputResultPath,
      variant: 'unit',
    });

    const result = await gtkExpect
      .expectCapture(capture, 'ocr-preprocess')
      .toContainText('Submit', {
        pageSegmentationModes: ['singleBlock'],
        preprocess: {
          grayscale: true,
          invert: true,
          scale: 2,
          threshold: 128,
        },
        region: {
          height: 2,
          width: 1,
          x: 1,
          y: 0,
        },
      });

    expect(result.outputResultPath).toBe(
      join(outputResultPath, 'unit', 'ocr-preprocess-000000')
    );
    const ocrInput = PNG.sync.read(await readFile(result.ocrInputImagePath!));
    expect(ocrInput.width).toBe(2);
    expect(ocrInput.height).toBe(4);
    await expect(
      JSON.parse(await readFile(result.metadataJsonPath!, 'utf8'))
    ).toMatchObject({
      expectedText: {
        type: 'string',
        value: 'Submit',
      },
      matcher: 'toContainText',
      preprocess: {
        grayscale: true,
        invert: true,
        scale: 2,
        threshold: 128,
      },
      region: {
        height: 2,
        width: 1,
        x: 1,
        y: 0,
      },
    });
  });

  it('releases OCR workers through Releasable', async () => {
    const capture = createCapture(solidPng(8, 4, [255, 255, 255, 255]), 8, 4);
    const perReadExpect = createGtkCaptureExpect();

    await perReadExpect
      .expectCapture(capture, 'per-read')
      .toContainText('Submit', {
        pageSegmentationModes: ['singleBlock'],
      });
    await perReadExpect.release();

    expect(tesseractMock.state.createWorker).toHaveBeenCalledTimes(1);
    expect(tesseractMock.state.workers[0]!.terminate).toHaveBeenCalledTimes(1);

    tesseractMock.reset();
    const sharedExpect = createGtkCaptureExpect({
      ocr: {
        workerMode: 'shared',
      },
    });
    await sharedExpect
      .expectCapture(capture, 'shared-a')
      .toContainText('Submit', {
        pageSegmentationModes: ['singleBlock'],
      });
    await sharedExpect
      .expectCapture(capture, 'shared-b')
      .toContainText('Submit', {
        pageSegmentationModes: ['singleBlock'],
      });
    await sharedExpect[Symbol.asyncDispose]();
    await sharedExpect.release();

    expect(tesseractMock.state.createWorker).toHaveBeenCalledTimes(1);
    expect(tesseractMock.state.workers[0]!.recognize).toHaveBeenCalledTimes(2);
    expect(tesseractMock.state.workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('GTK capture visual testing types', () => {
  it('exposes typed capture expectation APIs', async () => {
    if (false) {
      const region: GtkCapturePixelRegion = {
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      };
      const lookOptions: GtkCaptureLookSimilarOptions = {
        maxDiffPixels: 1,
        maxDiffRatio: 0.01,
        region,
        threshold: 0.1,
      };
      const similarityOptions: GtkCaptureSimilarityOptions = {
        masks: [region],
        minSimilarity: 0.99,
      };
      const ocrOptions: GtkCaptureOcrOptions = {
        pageSegmentationModes: ['singleBlock', 'singleLine'],
        preprocess: {
          grayscale: true,
          scale: 2,
          threshold: 128,
        },
        region,
      };
      const ocrAssertionOptions: GtkCaptureOcrAssertionOptions = {
        ...ocrOptions,
        caseSensitive: false,
        minConfidence: 50,
        normalizeWhitespace: true,
      };
      const capture = undefined as unknown as GtkCapture;
      const expectedBuffer: GtkCaptureExpectedImage = Buffer.alloc(0);
      const expectedImagePath: GtkCaptureExpectedImage =
        'tests/images/black-4x4.png';
      const expectedUrl: GtkCaptureExpectedImage = new URL(
        './images/black-4x4.png',
        import.meta.url
      );
      const expectation: GtkCaptureExpectation = expectCapture(
        capture,
        'typed'
      );
      const gtkExpect: GtkCaptureExpect = createGtkCaptureExpect({
        ocr: {
          languages: 'eng',
          workerMode: 'shared',
        },
      });
      const releasable: Releasable = gtkExpect;
      const lookResult: GtkCaptureLookSimilarResult =
        await expectation.toLookSimilar(expectedBuffer, lookOptions);
      const similarityResult: GtkCaptureSimilarityResult =
        await expectation.toHaveSimilarity(expectedUrl, similarityOptions);
      const ocrText: GtkCaptureOcrText = await expectation.readText(ocrOptions);
      const ocrResult: GtkCaptureOcrResult = await expectation.toContainText(
        /submit/i,
        ocrAssertionOptions
      );

      expect(lookResult.diffPixels).toBe(similarityResult.diffPixels);
      expect(ocrText.text).toBe(ocrResult.text);
      await releasable.release();
      await gtkExpect[Symbol.asyncDispose]();
      // @ts-expect-error expected image must be supplied before options.
      await expectation.toLookSimilar(lookOptions);
      await expectation.toLookSimilar(expectedImagePath, {
        // @ts-expect-error unknown options must not be accepted.
        unknownOption: true,
      });
      await expectation.toContainText('Submit', {
        // @ts-expect-error unknown OCR options must not be accepted.
        unknownOption: true,
      });
    }

    expect(true).toBe(true);
  });
});
