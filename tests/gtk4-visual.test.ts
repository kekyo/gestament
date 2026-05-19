// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type {
  GtkApp,
  GtkAutomationError,
  GtkCapture,
  GtkElementOfKind,
  GtkTrayItem,
  GtkWidgetKind,
  GtkWidgetElement,
} from '../src/types';
import { createGtkAppLauncher } from '../src/launchGtkApp';
import { createGtkCaptureExpect, waitForResult } from '../src/testing';
import {
  expectPngRegionToContainNonLightPixels,
  expectPngToContainDarkPixels,
} from './support/imageAssertions';
import {
  expectCaptureArtifact,
  expectCaptureNotToMatchMaster,
  expectCaptureRegionToMatchCapture,
  expectCaptureSurfaceText,
} from './support/captureAssertions';
import { spawnText } from './support/process';
import { saveCaptureArtifact } from './support/testArtifacts';
import {
  gtk4FixtureTimeoutMs as fixtureTimeoutMs,
  gtk4MissingLookupTimeoutMs as missingLookupTimeoutMs,
  gtk4VisualTestTimeoutMs as testTimeoutMs,
} from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const appPath = fileURLToPath(
  new URL('../.build/gtk4-test-app/gtk4-test-app', import.meta.url)
);
const packageEntryPath = fileURLToPath(
  new URL('../dist/index.cjs', import.meta.url)
);
const testBackend = process.env.GESTAMENT_TEST_BACKEND;
const describeGtk4 = testBackend === 'gtk4' ? describe : describe.skip;
const spMonImageUrl = new URL('./images/sp_mon.png', import.meta.url);
const dawnCatImageUrl = new URL('./images/dawn_cat.png', import.meta.url);
const spMonImageSize = {
  height: 225,
  width: 300,
} as const;

const launcher = createGtkAppLauncher({
  appPath,
  timeoutMs: fixtureTimeoutMs,
});
const shortLauncher = createGtkAppLauncher({
  appPath,
  timeoutMs: missingLookupTimeoutMs,
});

const waitForWindowCount = async (
  app: GtkApp,
  expectedCount: number
): Promise<void> => {
  const startedAt = Date.now();
  let lastCount = 0;

  while (Date.now() - startedAt <= fixtureTimeoutMs) {
    lastCount = await app.getWindowCount();
    if (lastCount === expectedCount) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  expect(lastCount).toBe(expectedCount);
};

const expectElement = (
  element: GtkWidgetElement | undefined
): GtkWidgetElement => {
  expect(element).toBeDefined();
  return element as GtkWidgetElement;
};

const expectElementKind = <Kind extends GtkWidgetKind>(
  element: GtkWidgetElement | undefined,
  kind: Kind
): GtkElementOfKind<Kind> => {
  const resolved = expectElement(element);
  expect(resolved.kind).toBe(kind);
  return resolved as GtkElementOfKind<Kind>;
};

const expectTrayItem = (item: GtkTrayItem | undefined): GtkTrayItem => {
  expect(item).toBeDefined();
  return item as GtkTrayItem;
};

const waitForVisualUpdate = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 300);
  });

const isUnsupportedImageInterfaceError = (
  error: unknown
): error is GtkAutomationError =>
  (error as { code?: unknown }).code === 'UNSUPPORTED_INTERFACE' &&
  (error as { message?: unknown }).message ===
    'Accessible element does not support Image.';

const expectSpMonImageCapture = async (capture: GtkCapture): Promise<void> => {
  expect(capture.clipped).toBe(false);
  expect(capture.visibleBounds).toEqual(capture.bounds);

  const png = PNG.sync.read(capture.image);
  expect(png.width).toBe(spMonImageSize.width);
  expect(png.height).toBe(spMonImageSize.height);

  const gtkExpect = createGtkCaptureExpect();
  await gtkExpect
    .expectCapture(capture, 'sp-mon-image')
    .toLookSimilar(spMonImageUrl, {
      maxDiffPixels: 0,
      maxDiffRatio: 0,
      threshold: 0.05,
    });
  await gtkExpect
    .expectCapture(capture, 'sp-mon-image')
    .toHaveSimilarity(spMonImageUrl, {
      minSimilarity: 0.995,
    });
  await expect(
    gtkExpect
      .expectCapture(capture, 'sp-mon-image')
      .toLookSimilar(dawnCatImageUrl, {
        maxDiffPixels: 0,
        maxDiffRatio: 0,
        threshold: 0.05,
      })
  ).rejects.toMatchObject({
    result: expect.objectContaining({
      pass: false,
    }),
  });
  await expect(
    gtkExpect
      .expectCapture(capture, 'sp-mon-image')
      .toHaveSimilarity(dawnCatImageUrl, {
        minSimilarity: 0.995,
      })
  ).rejects.toMatchObject({
    result: expect.objectContaining({
      pass: false,
    }),
  });
};

const expectImageElementFallbackCapture = (capture: GtkCapture): void => {
  expect(capture.clipped).toBe(false);
  expect(capture.visibleBounds).toEqual(capture.bounds);
  expect(capture.bounds.width).toBeGreaterThan(0);
  expect(capture.bounds.height).toBeGreaterThan(0);

  const png = PNG.sync.read(capture.image);
  expect(png.width).toBe(capture.bounds.width);
  expect(png.height).toBe(capture.bounds.height);
  expectPngToContainDarkPixels(capture.image, 1);
};

const waitForRejectedCode = async (
  operation: () => Promise<unknown>,
  expectedCode: string
): Promise<void> => {
  const startedAt = Date.now();
  let lastCode: unknown;

  while (Date.now() - startedAt <= 5_000) {
    try {
      await operation();
    } catch (error) {
      lastCode = (error as { code?: unknown }).code;
      if (lastCode === expectedCode) {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  expect(lastCode).toBe(expectedCode);
};

const expectCaptureBoundsWithin = (
  capture: GtkCapture,
  parentCapture: GtkCapture
): void => {
  expect(capture.visibleBounds).toEqual(capture.bounds);
  expect(capture.bounds.x).toBeGreaterThanOrEqual(parentCapture.bounds.x);
  expect(capture.bounds.y).toBeGreaterThanOrEqual(parentCapture.bounds.y);
  expect(capture.bounds.x + capture.bounds.width).toBeLessThanOrEqual(
    parentCapture.bounds.x + parentCapture.bounds.width
  );
  expect(capture.bounds.y + capture.bounds.height).toBeLessThanOrEqual(
    parentCapture.bounds.y + parentCapture.bounds.height
  );
};

const expectWindowNamed = async (
  app: GtkApp,
  name: string
): Promise<GtkElementOfKind<'window'>> => {
  const windowCount = await app.getWindowCount();
  for (let index = 0; index < windowCount; index += 1) {
    const window = expectElementKind(await app.windowAt(index), 'window');
    if ((await window.info()).name === name) {
      return window;
    }
  }

  throw new Error(`Window was not found: ${name}`);
};

afterEach(() => {
  return Promise.all([launcher.release(), shortLauncher.release()]);
});

/////////////////////////////////////////////////////////////////////////////////////////

describeGtk4('GTK4 AT-SPI automation', () => {
  it(
    'waits for GTK4 AT-SPI readiness before the first accessible lookup',
    async () => {
      const script = `
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const launcher = createGtkAppLauncher({
  appPath: ${JSON.stringify(appPath)},
  timeoutMs: ${JSON.stringify(fixtureTimeoutMs)},
});
(async () => {
  const app = await launcher.launch();
  try {
    await app.getById('name_entry');
  } finally {
    await launcher.release();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
      const result = await spawnText(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          GESTAMENT_GTK_BACKEND: 'gtk4',
        },
        timeoutMs: testTimeoutMs - 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('AT-SPI: Error in GetItems');
    },
    testTimeoutMs
  );

  it(
    'sets entry text, clicks a button, and reads label text',
    async () => {
      const app = await launcher.launch();

      const entry = expectElementKind(await app.getById('name_entry'), 'entry');
      const entryInfo = await entry.info();
      expect(entryInfo).toMatchObject({
        accessibleId: 'name_entry',
        kind: 'entry',
      });
      expect(entryInfo.roleName.length).toBeGreaterThan(0);
      expect(entryInfo.localizedRoleName.length).toBeGreaterThan(0);
      expect(entryInfo.interfaces.length).toBeGreaterThan(0);
      expect(entryInfo.states.length).toBeGreaterThan(0);
      await entry.setText('ABC');

      const button = expectElementKind(
        await app.getById('submit_button'),
        'button'
      );
      await expect(button.info()).resolves.toMatchObject({
        accessibleId: 'submit_button',
        kind: 'button',
      });
      await button.click();

      const label = expectElementKind(
        await app.getById('result_label'),
        'label'
      );
      await expect(label.info()).resolves.toMatchObject({
        accessibleId: 'result_label',
        kind: 'label',
      });
      await expect.poll(() => label.text()).toBe('ABC');
    },
    testTimeoutMs
  );

  it(
    'resolves child elements by AT-SPI child order',
    async () => {
      const app = await launcher.launch();

      const mainWindow = expectElementKind(
        await app.getById('main_window'),
        'window'
      );
      expect(await mainWindow.getChildCount()).toBe(1);

      const mainBox = expectElementKind(
        await mainWindow.childAt(0),
        'container'
      );
      expect(await mainBox.getChildCount()).toBe(3);

      const entry = expectElementKind(await mainBox.childAt(0), 'entry');
      await entry.setText('XYZ');

      const button = expectElementKind(await mainBox.childAt(1), 'button');
      await button.click();

      const label = expectElementKind(await mainBox.childAt(2), 'label');
      await expect.poll(() => label.text()).toBe('XYZ');
      await expect(mainBox.childAt(3)).resolves.toBeUndefined();
    },
    testTimeoutMs
  );

  it(
    'resolves element paths by accessible id and child order',
    async () => {
      const app = await launcher.launch();

      const mainWindow = expectElementKind(
        await app.getByPath('main_window'),
        'window'
      );
      await expect(mainWindow.info()).resolves.toMatchObject({
        accessibleId: 'main_window',
      });

      const entry = expectElementKind(
        await app.getByPath('main_window.0:0'),
        'entry'
      );
      await entry.setText('PATH');

      const button = expectElementKind(
        await app.getByPath('main_window:0;1'),
        'button'
      );
      await button.click();

      const label = expectElementKind(
        await app.findByPath('main_window,0.2'),
        'label'
      );
      await expect.poll(() => label.text()).toBe('PATH');
    },
    testTimeoutMs
  );

  it(
    'captures real screen pixels for an accessible id',
    async () => {
      const app = await launcher.launch();

      const button = await app.getById('submit_button');
      const capture = await button.capture();
      await expectCaptureArtifact(capture, 'submit-button');
      await expectCaptureSurfaceText(
        capture,
        'submit-button',
        'Submit',
        'Cancel'
      );
      const png = PNG.sync.read(capture.image);

      expect(capture.bounds.width).toBeGreaterThan(0);
      expect(capture.bounds.height).toBeGreaterThan(0);
      expect(capture.visibleBounds).toEqual(capture.bounds);
      expect(capture.clipped).toBe(false);
      expect(png.width).toBe(capture.visibleBounds.width);
      expect(png.height).toBe(capture.visibleBounds.height);
    },
    testTimeoutMs
  );

  it(
    'captures the full X11 root window for the launched app',
    async () => {
      const app = await launcher.launch();

      await waitForWindowCount(app, 1);
      const capture = await app.capture();
      await saveCaptureArtifact(capture, 'screen');
      const png = PNG.sync.read(capture.image);
      expect(capture.bounds).toEqual(capture.visibleBounds);
      expect(capture.bounds.x).toBe(0);
      expect(capture.bounds.y).toBe(0);
      expect(capture.bounds.width).toBeGreaterThan(0);
      expect(capture.bounds.height).toBeGreaterThan(0);
      expect(capture.clipped).toBe(false);
      expect(png.width).toBe(capture.bounds.width);
      expect(png.height).toBe(capture.bounds.height);

      const mainWindow = expectElement(await app.windowAt(0));
      expectCaptureBoundsWithin(await mainWindow.capture(), capture);
      const submitButton = await app.getById('submit_button');
      const submitButtonCapture = await submitButton.capture();
      expectCaptureBoundsWithin(submitButtonCapture, capture);
      expectCaptureRegionToMatchCapture(capture, submitButtonCapture);
    },
    testTimeoutMs
  );

  it(
    'captures covering window pixels when an accessible is obscured',
    async () => {
      const uncoveredApp = await launcher.launch();
      const uncoveredButton = await uncoveredApp.getById('submit_button');
      const uncoveredCapture = await uncoveredButton.capture();
      await expectCaptureArtifact(uncoveredCapture, 'uncovered-submit-button');
      await uncoveredApp.release();

      const coveredApp = await launcher.launch(['--cover-submit-button']);
      await waitForWindowCount(coveredApp, 2);
      const coveredButton = await coveredApp.getById('submit_button');
      const coveredCapture = await coveredButton.capture();
      await expectCaptureArtifact(coveredCapture, 'covered-submit-button');

      const uncoveredPng = PNG.sync.read(uncoveredCapture.image);
      const coveredPng = PNG.sync.read(coveredCapture.image);
      expect(coveredPng.width).toBe(uncoveredPng.width);
      expect(coveredPng.height).toBe(uncoveredPng.height);

      const diff = new PNG({
        height: uncoveredPng.height,
        width: uncoveredPng.width,
      });
      const diffPixels = pixelmatch(
        uncoveredPng.data,
        coveredPng.data,
        diff.data,
        uncoveredPng.width,
        uncoveredPng.height,
        { threshold: 0.1 }
      );

      expect(diffPixels).toBeGreaterThan(0);
    },
    testTimeoutMs
  );

  it(
    'resolves top-level windows by index',
    async () => {
      const app = await launcher.launch();

      await waitForWindowCount(app, 1);
      const mainWindow = expectElement(await app.windowAt(0));
      await expect(app.windowAt(1)).resolves.toBeUndefined();

      const mainCapture = await mainWindow.capture();
      await expectCaptureArtifact(mainCapture, 'main-window');
      expect(mainCapture.image.length).toBeGreaterThan(0);
      await app.release();

      const coveredApp = await launcher.launch(['--cover-submit-button']);
      await waitForWindowCount(coveredApp, 2);
      const coveredMainWindow = expectElementKind(
        await coveredApp.getById('main_window'),
        'window'
      );
      const coverWindow = await expectWindowNamed(coveredApp, 'Cover Window');
      await expect(coveredApp.windowAt(2)).resolves.toBeUndefined();

      const coveredMainCapture = await coveredMainWindow.capture();
      const coverCapture = await coverWindow.capture();
      const coveredSubmitButton = expectElementKind(
        await coveredApp.getById('submit_button'),
        'button'
      );
      const coveredSubmitCapture = await coveredSubmitButton.capture();
      expect(coverCapture.bounds).toEqual(coveredSubmitCapture.bounds);
      expect(coverCapture.visibleBounds).toEqual(
        coveredSubmitCapture.visibleBounds
      );
      await expectCaptureArtifact(coveredMainCapture, 'covered-main-window');
      await expectCaptureArtifact(coverCapture, 'cover-window');
      expect(coveredMainCapture.image.length).toBeGreaterThan(0);
      expect(coverCapture.image.length).toBeGreaterThan(0);
    },
    testTimeoutMs
  );

  it(
    'reports undefined when an accessible id is missing',
    async () => {
      const app = await shortLauncher.launch();

      await expect(
        app.findById('missing_accessible_id')
      ).resolves.toBeUndefined();
    },
    testTimeoutMs
  );

  it(
    'rejects when an accessible id is missing',
    async () => {
      const app = await shortLauncher.launch();

      await expect(app.getById('missing_accessible_id')).rejects.toMatchObject({
        code: 'ELEMENT_NOT_FOUND',
      });
    },
    testTimeoutMs
  );

  it(
    'shares waitForResult deadlines with driver-backed lookups',
    async () => {
      const app = await shortLauncher.launch();
      const startedAt = Date.now();

      await expect(
        waitForResult(() => app.getById('missing_accessible_id'), {
          intervalMs: 10,
          message: 'missing lookup should use the outer wait deadline.',
          timeoutMs: 200,
        })
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: expect.stringContaining('outer wait deadline'),
      });
      expect(Date.now() - startedAt).toBeLessThan(missingLookupTimeoutMs / 2);
    },
    testTimeoutMs
  );

  it(
    'reports undefined when an element path is missing',
    async () => {
      const app = await shortLauncher.launch();

      await expect(app.findByPath('main_window.0.3')).resolves.toBeUndefined();
    },
    testTimeoutMs
  );

  it(
    'rejects when an element path is missing',
    async () => {
      const app = await shortLauncher.launch();

      await expect(app.getByPath('main_window.0.3')).rejects.toMatchObject({
        code: 'ELEMENT_NOT_FOUND',
      });
    },
    testTimeoutMs
  );

  it(
    'rejects invalid indexes as invalid arguments',
    async () => {
      const app = await launcher.launch();
      const mainWindow = expectElementKind(
        await app.getById('main_window'),
        'window'
      );

      await expect(app.windowAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(mainWindow.childAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(app.trayItemAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(app.getByPath('main_window..0')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(app.findByPath('main_window.-1')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(app.findByPath('main_window.child')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(
        app.findByPath('main_window.9007199254740992')
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    },
    testTimeoutMs
  );

  it(
    'reports stale element when a held element is used after app close',
    async () => {
      const app = await launcher.launch();
      const button = await app.getById('submit_button');

      await app.release();

      await expect(button.capture()).rejects.toMatchObject({
        code: 'STALE_ELEMENT',
      });
    },
    testTimeoutMs
  );

  it(
    'reads and controls checkable and value widgets',
    async () => {
      const app = await launcher.launch(['--widget-controls']);
      await app.getById('controls_window');

      const checkbox = expectElementKind(
        await app.getById('check_control'),
        'checkbox'
      );
      expect(await checkbox.isChecked()).toBe(false);
      await checkbox.toggle();
      await expect.poll(() => checkbox.isChecked()).toBe(true);
      await checkbox.toggle();
      await expect.poll(() => checkbox.isChecked()).toBe(false);
      await waitForVisualUpdate();
      await expectCaptureArtifact(await checkbox.capture(), 'checkbox');

      const switchControl = expectElementKind(
        await app.getById('switch_control'),
        'switch'
      );
      expect(await switchControl.isChecked()).toBe(false);
      await switchControl.toggle();
      await expect.poll(() => switchControl.isChecked()).toBe(true);
      await waitForVisualUpdate();
      const switchOnCapture = await switchControl.capture();
      await expectCaptureArtifact(switchOnCapture, 'switch-on');
      await switchControl.toggle();
      await expect.poll(() => switchControl.isChecked()).toBe(false);
      await waitForVisualUpdate();
      const switchOffCapture = await switchControl.capture();
      await expectCaptureArtifact(switchOffCapture, 'switch-off');
      await expectCaptureNotToMatchMaster(
        switchOnCapture,
        'switch-on',
        'switch-off'
      );
      await expectCaptureNotToMatchMaster(
        switchOffCapture,
        'switch-off',
        'switch-on'
      );

      const toggleButton = expectElementKind(
        await app.getById('toggle_button_control'),
        'toggleButton'
      );
      expect(await toggleButton.isChecked()).toBe(false);
      await toggleButton.toggle();
      await expect.poll(() => toggleButton.isChecked()).toBe(true);
      await waitForVisualUpdate();
      const toggleButtonOnCapture = await toggleButton.capture();
      await expectCaptureArtifact(toggleButtonOnCapture, 'toggle-button-on');
      await toggleButton.toggle();
      await expect.poll(() => toggleButton.isChecked()).toBe(false);
      await waitForVisualUpdate();
      const toggleButtonOffCapture = await toggleButton.capture();
      await expectCaptureArtifact(toggleButtonOffCapture, 'toggle-button-off');
      await expectCaptureNotToMatchMaster(
        toggleButtonOnCapture,
        'toggle-button-on',
        'toggle-button-off'
      );
      await expectCaptureNotToMatchMaster(
        toggleButtonOffCapture,
        'toggle-button-off',
        'toggle-button-on'
      );

      const radioA = expectElementKind(
        await app.getById('radio_a_control'),
        'radio'
      );
      const radioB = expectElementKind(
        await app.getById('radio_b_control'),
        'radio'
      );
      expect(await radioA.isChecked()).toBe(true);
      expect(await radioB.isChecked()).toBe(false);
      await radioB.toggle();
      await expect.poll(() => radioA.isChecked()).toBe(false);
      await expect.poll(() => radioB.isChecked()).toBe(true);
      await radioA.toggle();
      await expect.poll(() => radioA.isChecked()).toBe(true);
      await expect.poll(() => radioB.isChecked()).toBe(false);
      await waitForVisualUpdate();
      const radioACapture = await radioA.capture();
      const radioBCapture = await radioB.capture();
      await expectCaptureArtifact(radioACapture, 'radio-a');
      await expectCaptureArtifact(radioBCapture, 'radio-b');
      await expectCaptureNotToMatchMaster(radioACapture, 'radio-a', 'radio-b');
      await expectCaptureNotToMatchMaster(radioBCapture, 'radio-b', 'radio-a');

      const spinButton = expectElementKind(
        await app.getById('spin_button_control'),
        'spinButton'
      );
      await expect(spinButton.valueInfo()).resolves.toMatchObject({
        value: 2,
        minimum: 0,
        maximum: 10,
        minimumIncrement: 0,
      });
      await spinButton.increment();
      await expect.poll(() => spinButton.value()).toBe(3);
      await spinButton.decrement();
      await expect.poll(() => spinButton.value()).toBe(2);
      await spinButton.setValue(7);
      await expect.poll(() => spinButton.value()).toBe(7);
      await waitForVisualUpdate();
      await expectCaptureArtifact(await spinButton.capture(), 'spin-button');

      const slider = expectElementKind(
        await app.getById('slider_control'),
        'slider'
      );
      await expect(slider.value()).resolves.toBe(25);
      await slider.setValue(40);
      await expect.poll(() => slider.value()).toBe(40);
      await waitForVisualUpdate();
      await expectCaptureArtifact(await slider.capture(), 'slider');

      const progressBar = expectElementKind(
        await app.getById('progress_bar_control'),
        'progressBar'
      );
      await expect(progressBar.value()).resolves.toBeCloseTo(0.4, 5);
      await expectCaptureArtifact(await progressBar.capture(), 'progress-bar');

      const image = expectElementKind(
        await app.getById('image_control'),
        'image'
      );
      const imageInfo = await image.imageInfo().catch((error: unknown) => {
        if (!isUnsupportedImageInterfaceError(error)) {
          throw error;
        }
        return undefined;
      });

      if (imageInfo === undefined) {
        const imageCapture = await image.capture();
        await saveCaptureArtifact(imageCapture, 'sp-mon-image');
        expectImageElementFallbackCapture(imageCapture);
      } else {
        expect(imageInfo.description).toEqual(expect.any(String));
        expect(imageInfo.locale).toEqual(expect.any(String));
        expect(imageInfo.size).toEqual(spMonImageSize);
        expect(imageInfo.bounds.width).toBe(spMonImageSize.width);
        expect(imageInfo.bounds.height).toBe(spMonImageSize.height);
        const imageCapture = await imageInfo.capture();
        expect(imageCapture.bounds).toEqual(imageInfo.bounds);
        await saveCaptureArtifact(imageCapture, 'sp-mon-image');
        await expectSpMonImageCapture(imageCapture);
      }
    },
    testTimeoutMs
  );

  it(
    'enumerates and selects typed child widgets',
    async () => {
      const app = await launcher.launch(['--widget-enumerables']);
      await expect
        .poll(async () => (await app.windowAt(1)) !== undefined)
        .toBe(true);
      const enumerablesWindow = expectElementKind(
        await app.windowAt(1),
        'window'
      );
      expect(await enumerablesWindow.getChildCount()).toBe(1);

      const enumerablesBox = expectElementKind(
        await enumerablesWindow.childAt(0),
        'container'
      );
      expect(await enumerablesBox.getChildCount()).toBe(4);
      await expect(enumerablesBox.childAt(4)).resolves.toBeUndefined();

      const combo = expectElementKind(
        await enumerablesBox.childAt(0),
        'comboBox'
      );
      const comboBoxCapture = await combo.capture();
      await expectCaptureArtifact(comboBoxCapture, 'combo-box');

      const list = expectElementKind(await enumerablesBox.childAt(1), 'list');
      expect(await list.getChildCount()).toBe(3);
      await expectCaptureArtifact(await list.capture(), 'list');
      const listItem0 = expectElementKind(await list.childAt(0), 'listItem');
      const listItem1 = expectElementKind(await list.childAt(1), 'listItem');
      const listItem2 = expectElementKind(await list.childAt(2), 'listItem');
      await expect(list.childAt(3)).resolves.toBeUndefined();
      await expect(listItem0.info()).resolves.toMatchObject({
        kind: 'listItem',
        name: 'List A',
      });
      await expect(listItem1.info()).resolves.toMatchObject({
        kind: 'listItem',
        name: 'List B',
      });
      await expect(listItem2.info()).resolves.toMatchObject({
        kind: 'listItem',
        name: 'List C',
      });
      const listItem0Capture = await listItem0.capture();
      await expectCaptureArtifact(listItem0Capture, 'list-item-0');
      await expectCaptureSurfaceText(
        listItem0Capture,
        'list-item-0',
        'List A',
        'Submit'
      );
      await expectCaptureArtifact(await listItem1.capture(), 'list-item-1');
      await expectCaptureArtifact(await listItem2.capture(), 'list-item-2');
      await expect(list.getSelectedChildCount()).resolves.toBe(0);
      await list.selectChildAt(1);
      await listItem1.click();
      await expect.poll(() => list.isChildSelected(1)).toBe(true);
      await waitForVisualUpdate();
      const selectedListItem = expectElementKind(
        await list.selectedChildAt(0),
        'listItem'
      );
      await expect(selectedListItem.info()).resolves.toMatchObject({
        name: 'List B',
      });
      const selectedListItemCapture = await selectedListItem.capture();
      await expectCaptureArtifact(
        selectedListItemCapture,
        'selected-list-item'
      );
      await expectCaptureNotToMatchMaster(
        selectedListItemCapture,
        'selected-list-item',
        'list-item-1'
      );
      await list.selectAllChildren();
      await expect.poll(() => list.getSelectedChildCount()).toBe(3);
      await list.deselectChildAt(1);
      await expect.poll(() => list.isChildSelected(1)).toBe(false);
      await list.clearSelection();
      await expect.poll(() => list.getSelectedChildCount()).toBe(0);
      await expect(list.childAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(list.childAt(1.25)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(list.childAt(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(list.selectChildAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(list.selectChildAt(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(list.selectChildAt(3)).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
      });

      const menu = expectElementKind(await enumerablesBox.childAt(2), 'menu');
      expect(await menu.getChildCount()).toBe(1);
      await expectCaptureArtifact(await menu.capture(), 'menu');
      const menuItem0 = expectElementKind(await menu.childAt(0), 'menuItem');
      await expect(menu.childAt(1)).resolves.toBeUndefined();
      await expect(menuItem0.info()).resolves.toMatchObject({
        name: 'Actions',
      });
      const menuItem0Capture = await menuItem0.capture();
      await expectCaptureArtifact(menuItem0Capture, 'menu-submenu-item-0');
      await expectCaptureSurfaceText(
        menuItem0Capture,
        'menu-submenu-item-0',
        'Actions',
        'Submit'
      );

      const table = expectElementKind(await enumerablesBox.childAt(3), 'table');
      const tableCapture = await table.capture();
      expectCaptureBoundsWithin(tableCapture, await enumerablesBox.capture());
      await expectCaptureArtifact(tableCapture, 'table');
      expect(await table.getRowCount()).toBe(2);
      expect(await table.getColumnCount()).toBe(3);
      const expectedCells = [
        ['R0C0', 'R0C1', 'R0C2'],
        ['R1C0', 'R1C1', 'R1C2'],
      ];
      const tableCellCaptures: GtkCapture[][] = [];
      for (let row = 0; row < expectedCells.length; row += 1) {
        const rowCells = expectedCells[row]!;
        const rowCaptures: GtkCapture[] = [];
        for (let column = 0; column < rowCells.length; column += 1) {
          const cell = expectElementKind(
            await table.cellAt(row, column),
            'tableCell'
          );
          const info = await cell.info();
          expect([info.name, info.description]).toContain(rowCells[column]);
          const capture = await cell.capture();
          rowCaptures.push(capture);
          await expectCaptureArtifact(capture, `table-cell-${row}-${column}`);
        }
        tableCellCaptures.push(rowCaptures);
      }
      await expectCaptureNotToMatchMaster(
        tableCellCaptures[0]![1]!,
        'table-cell-0-1',
        'table-cell-1-1'
      );
      await expect(table.cellAt(2, 0)).resolves.toBeUndefined();
      await expect(table.cellAt(0, 3)).resolves.toBeUndefined();
      await expect(table.cellAt(-1, 0)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(table.cellAt(0.25, 0)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(table.cellAt(Number.NaN, 0)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(table.selectRow(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(table.selectRow(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(table.selectedRows()).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(table.selectedColumns()).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(table.isRowSelected(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(table.isColumnSelected(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(table.isCellSelected(0, 0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });

      await combo.click();
      await waitForVisualUpdate();
      expect(await combo.getChildCount()).toBe(3);
      const expandedComboItem0 = expectElementKind(
        await combo.childAt(0),
        'listItem'
      );
      await expect(expandedComboItem0.info()).resolves.toMatchObject({
        name: 'Combo A',
      });
      await expectCaptureArtifact(
        await expandedComboItem0.capture(),
        'combo-box-expanded-item-0'
      );
      const comboItems = await Promise.all([
        combo.childAt(0),
        combo.childAt(1),
        combo.childAt(2),
      ]);
      const comboItemNames = ['Combo A', 'Combo B', 'Combo C'];
      for (const [index, item] of comboItems.entries()) {
        const comboItem = expectElementKind(item, 'listItem');
        await expect(comboItem.info()).resolves.toMatchObject({
          name: comboItemNames[index],
        });
      }
      await expect(combo.childAt(3)).resolves.toBeUndefined();
      await expect(combo.childAt(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(combo.childAt(1.25)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(combo.childAt(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(combo.getSelectedChildCount()).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(combo.selectedChildAt(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(combo.isChildSelected(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(combo.selectChildAt(1)).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
      });
      await expect(combo.deselectChildAt(0)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
      await expect(combo.selectChildAt(1)).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
      });
      await expect(combo.isChildSelected(1)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INTERFACE',
      });
    },
    testTimeoutMs
  );

  it(
    'resolves and controls a StatusNotifier tray item',
    async () => {
      const app = await launcher.launch(['--status-notifier-item']);

      const trayItem = await app.getTrayItem({ id: 'gestament-fixture' });
      expect(await app.getTrayItemCount()).toBe(1);
      expect(await app.trayItemAt(1)).toBeUndefined();

      const indexedTrayItem = expectTrayItem(await app.trayItemAt(0));
      await expect(indexedTrayItem.metadata()).resolves.toMatchObject({
        backend: 'status-notifier',
        iconName: 'dialog-information',
        id: 'gestament-fixture',
        status: 'Active',
        title: 'Gestament Fixture',
      });

      const element = expectElement(await trayItem.element());
      const capture = await trayItem.capture();
      await expectCaptureArtifact(capture, 'tray-item');
      const png = PNG.sync.read(capture.image);
      expect(await trayItem.openMenu()).toBeUndefined();
      expect(capture.bounds.width).toBeGreaterThan(0);
      expect(capture.bounds.height).toBeGreaterThan(0);
      expect(png.width).toBe(capture.visibleBounds.width);
      expect(png.height).toBe(capture.visibleBounds.height);
      expectPngToContainDarkPixels(capture.image, 10);
      expectPngRegionToContainNonLightPixels(
        capture.image,
        {
          height: png.height,
          width: Math.min(48, png.width),
          x: 0,
          y: 0,
        },
        10
      );

      await trayItem.click();
      const label = expectElementKind(
        await app.getById('result_label'),
        'label'
      );
      await expect.poll(() => label.text()).toBe('tray-activated');

      const elementCapture = await element.capture();
      expect(elementCapture.bounds).toEqual(capture.bounds);
      expect(elementCapture.visibleBounds).toEqual(capture.visibleBounds);
      expect(elementCapture.image).toEqual(capture.image);
    },
    testTimeoutMs
  );

  it(
    'rejects when a StatusNotifier tray item is missing',
    async () => {
      const app = await shortLauncher.launch();

      await expect(
        app.getTrayItem({ id: 'missing-gestament-fixture' })
      ).rejects.toMatchObject({
        code: 'ELEMENT_NOT_FOUND',
      });
    },
    testTimeoutMs
  );

  it(
    'reports stale element when a held tray item is used after app close',
    async () => {
      const app = await launcher.launch(['--status-notifier-item']);
      const trayItem = await app.getTrayItem({ id: 'gestament-fixture' });

      await app.release();

      await waitForRejectedCode(async () => {
        await trayItem.metadata();
      }, 'STALE_ELEMENT');
    },
    testTimeoutMs
  );
});
