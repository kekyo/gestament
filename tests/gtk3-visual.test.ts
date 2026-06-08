// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { AsyncLocalStorage } from 'node:async_hooks';
import { aroundEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type {
  GtkApp,
  GtkAppLauncher,
  GtkCapture,
  GtkElementOfKind,
  GtkTrayItem,
  GtkWidgetKind,
  GtkWidgetElement,
} from '../src/types';
import { createGtkAppLauncher } from '../src/launchGtkApp';
import { createGtkCaptureExpect, toPass, waitForResult } from '../src/testing';
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
  fixtureWindowDiscoveryTimeoutMs as fixtureTimeoutMs,
  missingLookupTimeoutMs,
  visualE2eTestTimeoutMs as testTimeoutMs,
} from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const appPath = fileURLToPath(
  new URL('../.build/gtk3-test-app/gtk3-test-app', import.meta.url)
);
const packageEntryPath = fileURLToPath(
  new URL('../dist/index.cjs', import.meta.url)
);
const testBackend = process.env.GESTAMENT_TEST_BACKEND;
const describeGtk3 = testBackend === 'gtk3' ? describe : describe.skip;
const visualSuiteOptions = {
  concurrent: true,
  timeout: testTimeoutMs,
} as const;
const spMonImageUrl = new URL('./images/sp_mon.png', import.meta.url);
const dawnCatImageUrl = new URL('./images/dawn_cat.png', import.meta.url);
const spMonImageSize = {
  height: 225,
  width: 300,
} as const;
const mainWindowResizeHints = {
  baseHeight: 40,
  baseWidth: 80,
  heightIncrement: 11,
  minHeight: 90,
  minWidth: 120,
  widthIncrement: 7,
} as const;
interface TestLauncherStore {
  defaultLauncher: GtkAppLauncher | undefined;
  geometryLauncher: GtkAppLauncher | undefined;
  shortLauncher: GtkAppLauncher | undefined;
}

const testLauncherStorage = new AsyncLocalStorage<
  TestLauncherStore | undefined
>();

const createLauncherStore = (): TestLauncherStore => ({
  defaultLauncher: undefined,
  geometryLauncher: undefined,
  shortLauncher: undefined,
});

const getLauncherStore = (): TestLauncherStore => {
  const store = testLauncherStorage.getStore();
  if (store === undefined) {
    throw new Error('No active GTK visual test launcher store.');
  }
  return store;
};

const getStoredLauncher = (
  key: keyof TestLauncherStore,
  createLauncher: () => GtkAppLauncher
): GtkAppLauncher => {
  const store = getLauncherStore();
  const existing = store[key];
  if (existing !== undefined) {
    return existing;
  }

  const launcher = createLauncher();
  store[key] = launcher;
  return launcher;
};

const createLauncherProxy = (
  resolveLauncher: () => GtkAppLauncher
): GtkAppLauncher => ({
  environment: () => resolveLauncher().environment(),
  launch: (...args: Parameters<GtkAppLauncher['launch']>) =>
    resolveLauncher().launch(...args),
  release: () => resolveLauncher().release(),
  systemOutput: () => resolveLauncher().systemOutput(),
  [Symbol.asyncDispose]: () => resolveLauncher().release(),
});

const launcher = createLauncherProxy(() =>
  getStoredLauncher('defaultLauncher', () =>
    createGtkAppLauncher({
      appPath,
      timeoutMs: fixtureTimeoutMs,
    })
  )
);
const shortLauncher = createLauncherProxy(() =>
  getStoredLauncher('shortLauncher', () =>
    createGtkAppLauncher({
      appPath,
      timeoutMs: missingLookupTimeoutMs,
    })
  )
);
const geometryLauncher = createLauncherProxy(() =>
  getStoredLauncher('geometryLauncher', () =>
    createGtkAppLauncher({
      appPath,
      timeoutMs: fixtureTimeoutMs,
      xvfbScreen: '800x600x24',
    })
  )
);

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

const expectChildAtKind = async <Kind extends GtkWidgetKind>(
  element: {
    readonly childAt: (index: number) => Promise<GtkWidgetElement | undefined>;
  },
  index: number,
  kind: Kind
): Promise<GtkElementOfKind<Kind>> =>
  await waitForResult(
    async () => expectElementKind(await element.childAt(index), kind),
    {
      message: `Timed out waiting for child ${index} kind ${kind}.`,
      timeoutMs: fixtureTimeoutMs,
    }
  );

const expectTrayItem = (item: GtkTrayItem | undefined): GtkTrayItem => {
  expect(item).toBeDefined();
  return item as GtkTrayItem;
};

const waitForVisualUpdate = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 300);
  });

const captureCenter = (capture: GtkCapture): { x: number; y: number } => ({
  x: capture.bounds.x + Math.floor(capture.bounds.width / 2),
  y: capture.bounds.y + Math.floor(capture.bounds.height / 2),
});

const expectPollToBe = async <Value>(
  probe: () => Value | Promise<Value>,
  expected: Value
): Promise<void> => {
  await toPass(
    async () => {
      expect(await probe()).toBe(expected);
    },
    {
      timeoutMs: fixtureTimeoutMs,
    }
  );
};

const expectPollToContain = async <Value>(
  probe: () => readonly Value[] | Promise<readonly Value[]>,
  expected: Value
): Promise<void> => {
  await toPass(
    async () => {
      expect(await probe()).toContain(expected);
    },
    {
      timeoutMs: fixtureTimeoutMs,
    }
  );
};

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

const waitForRejectedCode = async (
  operation: () => Promise<unknown>,
  expectedCode: string
): Promise<void> => {
  const startedAt = Date.now();
  let lastCode: unknown;

  while (Date.now() - startedAt <= missingLookupTimeoutMs) {
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

const expectWindowBoundsObserved = async (
  window: GtkElementOfKind<'window'>,
  expectedBounds: GtkCapture['bounds']
): Promise<void> => {
  await expect(window.bounds()).resolves.toEqual(expectedBounds);
  const capture = await window.capture();
  expect(capture.bounds).toEqual(expectedBounds);
};

const releaseLauncherStore = async (
  store: TestLauncherStore
): Promise<void> => {
  await Promise.all(
    [
      store.defaultLauncher,
      store.shortLauncher,
      store.geometryLauncher,
    ].flatMap((launcher) =>
      launcher === undefined ? [] : [launcher.release()]
    )
  );
};

aroundEach(async (runTest) => {
  const store = createLauncherStore();
  await testLauncherStorage.run(store, async () => {
    try {
      await runTest();
    } finally {
      await releaseLauncherStore(store);
    }
  });
}, testTimeoutMs);

/////////////////////////////////////////////////////////////////////////////////////////

describeGtk3('GTK3 AT-SPI automation', visualSuiteOptions, () => {
  it('sets entry text, clicks a button, and reads label text', async () => {
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

    const label = expectElementKind(await app.getById('result_label'), 'label');
    await expect(label.info()).resolves.toMatchObject({
      accessibleId: 'result_label',
      kind: 'label',
    });
    await expectPollToBe(() => label.text(), 'ABC');
  });

  it('synthesizes low-level input and window activation', async () => {
    const app = await launcher.launch(['--widget-controls']);

    const mainWindow = expectElementKind(
      await app.getById('main_window'),
      'window'
    );
    const controlsWindow = expectElementKind(
      await app.getById('controls_window'),
      'window'
    );
    const entry = expectElementKind(await app.getById('name_entry'), 'entry');
    const label = expectElementKind(await app.getById('result_label'), 'label');
    const probe = await app.getById('input_probe');

    await expect(app.input.pressKey('Shift_L')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    await mainWindow.activate();
    await expectPollToBe(() => label.text(), 'window-active:main');

    const entryCenter = captureCenter(await entry.capture());
    await app.input.moveMouseTo(entryCenter.x, entryCenter.y);
    await app.input.setMouseButton('left', true);
    await app.input.setMouseButton('left', false);
    await app.input.setModifier('shift', true);
    try {
      await app.input.pressKey('a');
    } finally {
      await app.input.setModifier('shift', false);
    }
    await expectPollToBe(() => entry.text(), 'A');

    await controlsWindow.activate();
    await expectPollToBe(() => label.text(), 'window-active:controls');

    const probeCenter = captureCenter(await probe.capture());
    await app.input.moveMouseTo(probeCenter.x, probeCenter.y);
    await app.input.setMouseButton('left', true);
    await expectPollToBe(() => label.text(), 'button-press:1');
    await app.input.setMouseButton('left', false);
    await expectPollToBe(() => label.text(), 'button-release:1');
    await app.input.scrollWheel(0, 1);
    await expectPollToBe(() => label.text(), 'scroll:down');
  });

  it('resolves child elements by AT-SPI child order', async () => {
    const app = await launcher.launch();

    const mainWindow = expectElementKind(
      await app.getById('main_window'),
      'window'
    );
    expect(await mainWindow.getChildCount()).toBe(1);

    const mainBox = await expectChildAtKind(mainWindow, 0, 'container');
    expect(await mainBox.getChildCount()).toBe(3);

    const entry = await expectChildAtKind(mainBox, 0, 'entry');
    await entry.setText('XYZ');

    const button = await expectChildAtKind(mainBox, 1, 'button');
    await button.click();

    const label = await expectChildAtKind(mainBox, 2, 'label');
    await expectPollToBe(() => label.text(), 'XYZ');
    await expect(mainBox.childAt(3)).resolves.toBeUndefined();
  });

  it('resolves element paths by accessible id and child order', async () => {
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
    await expectPollToBe(() => label.text(), 'PATH');
  });

  it('captures real screen pixels for an accessible id', async () => {
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
  });

  it('captures the full X11 root window for the launched app', async () => {
    const app = await launcher.launch();

    await waitForWindowCount(app, 1);
    const mainWindow = expectElementKind(await app.windowAt(0), 'window');
    await toPass(
      async () => {
        await expect(mainWindow.resizeHints()).resolves.toEqual(
          mainWindowResizeHints
        );
        await expect(mainWindow.x11Info()).resolves.toMatchObject({
          normalHints: mainWindowResizeHints,
        });
      },
      {
        message: 'Timed out waiting for GTK3 X11 resize hints.',
        timeoutMs: fixtureTimeoutMs,
      }
    );

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

    const mainWindowCapture = await mainWindow.capture();
    expectCaptureBoundsWithin(mainWindowCapture, capture);
    await expect(mainWindow.bounds()).resolves.toEqual(
      mainWindowCapture.bounds
    );
    let x11Info: Awaited<ReturnType<typeof mainWindow.x11Info>> | undefined;
    await toPass(
      async () => {
        await expect(mainWindow.resizeHints()).resolves.toEqual(
          mainWindowResizeHints
        );
        const nextX11Info = await mainWindow.x11Info();
        expect(nextX11Info).toMatchObject({
          normalHints: mainWindowResizeHints,
          title: 'Gestament GTK3 Fixture',
        });
        x11Info = nextX11Info;
      },
      {
        message: 'Timed out waiting for stable GTK3 X11 resize hints.',
        timeoutMs: fixtureTimeoutMs,
      }
    );
    expect(x11Info?.windowId).toMatch(/^0x[0-9a-f]+$/u);
    await expect(mainWindow.debugDiagnostics()).resolves.toMatchObject({
      rawIds: { x11: x11Info?.windowId },
      seenBy: expect.arrayContaining(['x11']),
    });
    const submitButton = await app.getById('submit_button');
    const submitButtonCapture = await submitButton.capture();
    expectCaptureBoundsWithin(submitButtonCapture, capture);
    expectCaptureRegionToMatchCapture(capture, submitButtonCapture);
  });

  it('moves and resizes top-level windows with screen captures', async () => {
    const app = await geometryLauncher.launch();

    await waitForWindowCount(app, 1);
    const mainWindow = expectElementKind(await app.windowAt(0), 'window');
    const initialBounds = await mainWindow.bounds();

    const movedBounds = await mainWindow.moveTo(80, 70);
    expect(movedBounds.x).not.toBe(initialBounds.x);
    expect(movedBounds.y).not.toBe(initialBounds.y);
    expect(movedBounds.width).toBe(initialBounds.width);
    expect(movedBounds.height).toBe(initialBounds.height);
    await expectWindowBoundsObserved(mainWindow, movedBounds);
    await expectCaptureArtifact(await app.capture(), 'window-moved-screen');

    const resizedBounds = await mainWindow.resizeTo(460, 220);
    expect(resizedBounds.x).toBe(movedBounds.x);
    expect(resizedBounds.y).toBe(movedBounds.y);
    expect(resizedBounds.width).not.toBe(movedBounds.width);
    expect(resizedBounds.height).not.toBe(movedBounds.height);
    await expectWindowBoundsObserved(mainWindow, resizedBounds);
    await expectCaptureArtifact(await app.capture(), 'window-resized-screen');

    const setBounds = await mainWindow.setBounds({
      height: 190,
      width: 300,
      x: 140,
      y: 90,
    });
    expect(setBounds.x).not.toBe(resizedBounds.x);
    expect(setBounds.y).not.toBe(resizedBounds.y);
    expect(setBounds.width).not.toBe(resizedBounds.width);
    expect(setBounds.height).not.toBe(resizedBounds.height);
    await expectWindowBoundsObserved(mainWindow, setBounds);
    await expectCaptureArtifact(
      await app.capture(),
      'window-set-bounds-screen'
    );
  });

  it(
    'moves windows through the direct launch API',
    async () => {
      const env = await geometryLauncher.environment();
      const script = `
const { launchGtkApp } = require(${JSON.stringify(packageEntryPath)});
const appPath = ${JSON.stringify(appPath)};
const env = ${JSON.stringify(env)};
const fixtureTimeoutMs = ${JSON.stringify(fixtureTimeoutMs)};
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const waitForWindowCount = async (app, expectedCount) => {
  const startedAt = Date.now();
  let lastCount = 0;
  while (Date.now() - startedAt <= fixtureTimeoutMs) {
    lastCount = await app.getWindowCount();
    if (lastCount === expectedCount) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(\`Expected window count \${expectedCount}, actual \${lastCount}.\`);
};
const assertBoundsEqual = (actual, expected, label) => {
  for (const key of ['height', 'width', 'x', 'y']) {
    assert(
      actual[key] === expected[key],
      \`\${label}.\${key}: expected \${expected[key]}, actual \${actual[key]}\`
    );
  }
};
(async () => {
  const app = await launchGtkApp(appPath, [], { env, timeoutMs: fixtureTimeoutMs });
  try {
    await waitForWindowCount(app, 1);
    const mainWindow = await app.windowAt(0);
    assert(mainWindow !== undefined, 'Main window was not found.');
    const initialBounds = await mainWindow.bounds();
    const movedBounds = await mainWindow.moveTo(120, 110);
    assert(movedBounds.x !== initialBounds.x, 'Window x did not change.');
    assert(movedBounds.y !== initialBounds.y, 'Window y did not change.');
    assertBoundsEqual(await mainWindow.bounds(), movedBounds, 'bounds');
    const capture = await mainWindow.capture();
    assertBoundsEqual(capture.bounds, movedBounds, 'capture.bounds');
  } finally {
    await app.release();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
      const result = await spawnText(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          ...env,
          GESTAMENT_GTK_BACKEND: 'gtk3',
        },
        timeoutMs: testTimeoutMs - 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
    },
    testTimeoutMs
  );

  it('rejects invalid window geometry arguments', async () => {
    const app = await geometryLauncher.launch();

    await waitForWindowCount(app, 1);
    const mainWindow = expectElementKind(await app.windowAt(0), 'window');

    await expect(mainWindow.moveTo(0.5, 0)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(mainWindow.resizeTo(0, 100)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      mainWindow.setBounds({ height: 100, width: 0, x: 0, y: 0 })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('captures covering window pixels when an accessible is obscured', async () => {
    const uncoveredApp = await launcher.launch();
    const uncoveredButton = await uncoveredApp.getById('submit_button');
    const uncoveredCapture = await uncoveredButton.capture();
    await expectCaptureArtifact(uncoveredCapture, 'uncovered-submit-button');
    await uncoveredApp.release();

    const coveredApp = await launcher.launch(['--cover-submit-button']);
    await coveredApp.getById('cover_window');
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
  });

  it('resolves top-level windows by index', async () => {
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

    const windowCount = await coveredApp.getWindowCount();
    expect(windowCount).toBeGreaterThanOrEqual(2);
    expect(await coveredApp.windowAt(windowCount)).toBeUndefined();

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
  });

  it('reports undefined when an accessible id is missing', async () => {
    const app = await shortLauncher.launch();

    await toPass(
      async () => {
        await expect(
          app.findById('missing_accessible_id')
        ).resolves.toBeUndefined();
      },
      {
        message: 'missing accessible id should resolve undefined',
        timeoutMs: missingLookupTimeoutMs,
      }
    );
  });

  it('rejects when an accessible id is missing', async () => {
    const app = await shortLauncher.launch();

    await waitForRejectedCode(async () => {
      await app.getById('missing_accessible_id');
    }, 'ELEMENT_NOT_FOUND');
  });

  it('shares waitForResult deadlines with driver-backed lookups', async () => {
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
  });

  it('reports undefined when an element path is missing', async () => {
    const app = await shortLauncher.launch();

    await toPass(
      async () => {
        await expect(
          app.findByPath('main_window.0.3')
        ).resolves.toBeUndefined();
      },
      {
        message: 'missing element path should resolve undefined',
        timeoutMs: missingLookupTimeoutMs,
      }
    );
  });

  it('rejects when an element path is missing', async () => {
    const app = await shortLauncher.launch();

    await waitForRejectedCode(async () => {
      await app.getByPath('main_window.0.3');
    }, 'ELEMENT_NOT_FOUND');
  });

  it('launches multiple apps and releases them from the launcher', async () => {
    const firstApp = await launcher.launch();
    const secondApp = await launcher.launch(['--cover-submit-button']);

    await firstApp.getById('main_window');
    await secondApp.getById('cover_window');

    await launcher.release();

    await expect(firstApp.getById('main_window')).rejects.toMatchObject({
      code: 'APP_EXITED',
    });
    await expect(secondApp.getById('cover_window')).rejects.toMatchObject({
      code: 'APP_EXITED',
    });
  });

  it('rejects invalid indexes as invalid arguments', async () => {
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
  });

  it('reports stale element when a held element is used after app close', async () => {
    const app = await launcher.launch();
    const button = await app.getById('submit_button');

    await app.release();

    await expect(button.capture()).rejects.toMatchObject({
      code: 'STALE_ELEMENT',
    });
  });

  it('reads and controls checkable and value widgets', async () => {
    const app = await launcher.launch(['--widget-controls']);
    await app.getById('controls_window');

    const checkbox = expectElementKind(
      await app.getById('check_control'),
      'checkbox'
    );
    expect(await checkbox.isChecked()).toBe(false);
    await checkbox.toggle();
    await expectPollToBe(() => checkbox.isChecked(), true);
    await checkbox.toggle();
    await expectPollToBe(() => checkbox.isChecked(), false);
    await waitForVisualUpdate();
    await expectCaptureArtifact(await checkbox.capture(), 'checkbox');

    const switchControl = expectElementKind(
      await app.getById('switch_control'),
      'switch'
    );
    expect(await switchControl.isChecked()).toBe(false);
    await switchControl.toggle();
    await expectPollToBe(() => switchControl.isChecked(), true);
    await waitForVisualUpdate();
    const switchOnCapture = await switchControl.capture();
    await expectCaptureArtifact(switchOnCapture, 'switch-on');
    await switchControl.toggle();
    await expectPollToBe(() => switchControl.isChecked(), false);
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
    await expectPollToBe(() => toggleButton.isChecked(), true);
    await waitForVisualUpdate();
    const toggleButtonOnCapture = await toggleButton.capture();
    await expectCaptureArtifact(toggleButtonOnCapture, 'toggle-button-on');
    await toggleButton.toggle();
    await expectPollToBe(() => toggleButton.isChecked(), false);
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
    await expectPollToBe(() => radioA.isChecked(), false);
    await expectPollToBe(() => radioB.isChecked(), true);
    await radioA.toggle();
    await expectPollToBe(() => radioA.isChecked(), true);
    await expectPollToBe(() => radioB.isChecked(), false);
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
      minimumIncrement: 1,
    });
    await spinButton.increment();
    await expectPollToBe(() => spinButton.value(), 3);
    await spinButton.decrement();
    await expectPollToBe(() => spinButton.value(), 2);
    await spinButton.setValue(7);
    await expectPollToBe(() => spinButton.value(), 7);
    await waitForVisualUpdate();
    await expectCaptureArtifact(await spinButton.capture(), 'spin-button');

    const slider = expectElementKind(
      await app.getById('slider_control'),
      'slider'
    );
    await expect(slider.value()).resolves.toBe(25);
    await slider.setValue(40);
    await expectPollToBe(() => slider.value(), 40);
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
    const imageInfo = await image.imageInfo();
    expect(imageInfo.description).toEqual(expect.any(String));
    expect(imageInfo.locale).toEqual(expect.any(String));
    expect(imageInfo.size).toEqual(spMonImageSize);
    expect(imageInfo.bounds.width).toBe(spMonImageSize.width);
    expect(imageInfo.bounds.height).toBe(spMonImageSize.height);

    const imageCapture = await imageInfo.capture();
    expect(imageCapture.bounds).toEqual(imageInfo.bounds);
    await saveCaptureArtifact(imageCapture, 'sp-mon-image');
    await expectSpMonImageCapture(imageCapture);
  });

  it('enumerates and selects typed child widgets', async () => {
    const app = await launcher.launch(['--widget-enumerables']);
    const enumerablesWindow = expectElementKind(
      await app.getById('enumerables_window'),
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
      await app.getById('enumerable_combo'),
      'comboBox'
    );
    expect(await combo.getChildCount()).toBe(3);
    const comboBoxCapture = await combo.capture();
    await expectCaptureArtifact(comboBoxCapture, 'combo-box');
    await combo.click();
    await waitForVisualUpdate();
    const expandedComboItem0 = expectElement(await combo.childAt(0));
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
      const comboItem = expectElement(item);
      expect(['listItem', 'menuItem']).toContain(comboItem.kind);
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
    await expect(combo.getSelectedChildCount()).resolves.toBe(1);
    await expect(combo.isChildSelected(0)).resolves.toBe(true);
    await expect(combo.isChildSelected(1)).resolves.toBe(false);
    await combo.selectChildAt(1);
    await expectPollToBe(async () => (await combo.info()).name, 'Combo B');
    await expectPollToBe(() => combo.isChildSelected(1), true);
    const selectedComboItem = expectElement(await combo.selectedChildAt(0));
    expect(['listItem', 'menuItem']).toContain(selectedComboItem.kind);
    await expect(selectedComboItem.info()).resolves.toMatchObject({
      name: 'Combo B',
    });
    try {
      await combo.clearSelection();
      await expectPollToBe(() => combo.getSelectedChildCount(), 0);
    } catch (error) {
      expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    }
    await combo.selectChildAt(1);
    await expectPollToBe(() => combo.isChildSelected(1), true);
    await expect(combo.selectChildAt(3)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    await expect(combo.isChildSelected(3)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    try {
      await combo.deselectChildAt(1);
      await expectPollToBe(() => combo.isChildSelected(1), false);
    } catch (error) {
      expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    }
    try {
      await combo.selectAllChildren();
      expect(await combo.getSelectedChildCount()).toBeGreaterThan(0);
    } catch (error) {
      expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    }

    const list = expectElementKind(
      await app.getById('enumerable_list'),
      'list'
    );
    expect(await list.getChildCount()).toBe(3);
    await expectCaptureArtifact(await list.capture(), 'list');
    const listItem0 = expectElementKind(await list.childAt(0), 'listItem');
    const listItem1 = expectElementKind(await list.childAt(1), 'listItem');
    const listItem2 = expectElementKind(await list.childAt(2), 'listItem');
    await expect(list.childAt(3)).resolves.toBeUndefined();
    await expect(listItem0.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_list_item_0',
      kind: 'listItem',
      name: 'List A',
    });
    await expect(listItem1.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_list_item_1',
      kind: 'listItem',
      name: 'List B',
    });
    await expect(listItem2.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_list_item_2',
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
    const listItem1Capture = await listItem1.capture();
    await expectCaptureArtifact(listItem1Capture, 'list-item-1');
    await expectCaptureArtifact(await listItem2.capture(), 'list-item-2');
    await expect(list.getSelectedChildCount()).resolves.toBe(0);
    await list.selectChildAt(1);
    await listItem1.click();
    await expectPollToBe(() => list.isChildSelected(1), true);
    await waitForVisualUpdate();
    const selectedListItem = expectElementKind(
      await list.selectedChildAt(0),
      'listItem'
    );
    await expect(selectedListItem.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_list_item_1',
    });
    const selectedListItemCapture = await selectedListItem.capture();
    await expectCaptureArtifact(selectedListItemCapture, 'selected-list-item');
    await expectCaptureNotToMatchMaster(
      selectedListItemCapture,
      'selected-list-item',
      'list-item-1'
    );
    await expectCaptureNotToMatchMaster(
      listItem1Capture,
      'list-item-1',
      'selected-list-item'
    );
    await list.selectAllChildren();
    await expectPollToBe(() => list.getSelectedChildCount(), 3);
    await list.deselectChildAt(1);
    await expectPollToBe(() => list.isChildSelected(1), false);
    await list.clearSelection();
    await expectPollToBe(() => list.getSelectedChildCount(), 0);
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

    const menu = expectElementKind(
      await app.getById('enumerable_menu'),
      'menu'
    );
    expect(await menu.getChildCount()).toBe(3);
    await expectCaptureArtifact(await menu.capture(), 'menu');
    const menuItem0 = expectElementKind(await menu.childAt(0), 'menuItem');
    const menuItem1 = expectElementKind(await menu.childAt(1), 'menuItem');
    const menuItem2 = expectElementKind(await menu.childAt(2), 'menuItem');
    await expect(menu.childAt(3)).resolves.toBeUndefined();
    await expect(menuItem0.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_menu_item_0',
      name: 'Menu A',
    });
    await expect(menuItem1.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_menu_item_1',
      name: 'Menu B',
    });
    await expect(menuItem2.info()).resolves.toMatchObject({
      accessibleId: 'enumerable_menu_item_2',
      name: 'Menu C',
    });
    const menuItem0Capture = await menuItem0.capture();
    await expectCaptureArtifact(menuItem0Capture, 'menu-action-item-0');
    await expectCaptureSurfaceText(
      menuItem0Capture,
      'menu-action-item-0',
      'Menu A',
      'Submit'
    );
    const menuItem1Capture = await menuItem1.capture();
    await expectCaptureArtifact(menuItem1Capture, 'menu-action-item-1');
    await expectCaptureSurfaceText(
      menuItem1Capture,
      'menu-action-item-1',
      'Menu B',
      'Submit'
    );
    const menuItem2Capture = await menuItem2.capture();
    await expectCaptureArtifact(menuItem2Capture, 'menu-action-item-2');
    await expectCaptureSurfaceText(
      menuItem2Capture,
      'menu-action-item-2',
      'Menu C',
      'Submit'
    );
    await menuItem2.click();
    const resultLabel = expectElementKind(
      await app.getById('result_label'),
      'label'
    );
    await expectPollToBe(() => resultLabel.text(), 'menu-2');

    const table = expectElementKind(
      await app.getById('enumerable_table'),
      'table'
    );
    expect(await table.getRowCount()).toBe(2);
    expect(await table.getColumnCount()).toBe(3);
    const tableCapture = await table.capture();
    expectCaptureBoundsWithin(tableCapture, await enumerablesBox.capture());
    await expectCaptureArtifact(tableCapture, 'table');
    const expectedCells = [
      ['R0C0', 'R0C1', 'R0C2'],
      ['R1C0', 'R1C1', 'R1C2'],
    ];
    for (let row = 0; row < expectedCells.length; row += 1) {
      const rowCells = expectedCells[row]!;
      for (let column = 0; column < rowCells.length; column += 1) {
        const cell = expectElementKind(
          await table.cellAt(row, column),
          'tableCell'
        );
        const info = await cell.info();
        expect([info.name, info.description]).toContain(rowCells[column]);
        await expectCaptureArtifact(
          await cell.capture(),
          `table-cell-${row}-${column}`
        );
      }
    }
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
    await expect(table.selectRow(2)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    await expect(table.selectRow(Number.NaN)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(table.selectedRows()).resolves.toEqual([]);
    await expect(table.selectedColumns()).resolves.toEqual([]);
    await table.selectRow(1);
    await expectPollToBe(() => table.isRowSelected(1), true);
    await expectPollToContain(() => table.selectedRows(), 1);
    await expectPollToBe(() => table.isCellSelected(1, 0), true);
    await table.deselectRow(1);
    await expectPollToBe(() => table.isRowSelected(1), false);
    await expect(table.isColumnSelected(1)).resolves.toBe(false);
    try {
      await table.selectColumn(1);
      await expectPollToBe(() => table.isColumnSelected(1), true);
      await expectPollToContain(() => table.selectedColumns(), 1);
      await table.deselectColumn(1);
      await expectPollToBe(() => table.isColumnSelected(1), false);
    } catch (error) {
      expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(table.isColumnSelected(1)).resolves.toBe(false);
      await expect(table.selectedColumns()).resolves.toEqual([]);
    }
  });

  it('recognizes and controls additional standard widgets', async () => {
    const app = await launcher.launch(['--widget-standards']);
    const resultLabel = expectElementKind(
      await app.getById('result_label'),
      'label'
    );

    const standardsWindow = expectElementKind(
      await app.getById('standards_window'),
      'window'
    );
    expect(await standardsWindow.getChildCount()).toBe(1);

    const standardsBox = expectElementKind(
      await app.getById('standards_box'),
      'container'
    );
    expect(await standardsBox.getChildCount()).toBe(11);

    const notebook = expectElementKind(
      await app.getById('standard_notebook'),
      'tabList'
    );
    expect(await notebook.getChildCount()).toBe(2);
    expect(await notebook.getSelectedChildCount()).toBe(1);
    const tabA = expectElementKind(await notebook.childAt(0), 'tab');
    const tabB = expectElementKind(await notebook.childAt(1), 'tab');
    await expect(tabA.info()).resolves.toMatchObject({ name: 'Notebook A' });
    await expect(tabB.info()).resolves.toMatchObject({ name: 'Notebook B' });
    await expect(tabA.isSelected()).resolves.toBe(true);
    await expect(tabB.isSelected()).resolves.toBe(false);
    await notebook.selectChildAt(1);
    await expectPollToBe(() => tabB.isSelected(), true);
    await expectCaptureArtifact(await notebook.capture(), 'standard-notebook');
    await tabA.select();
    await expectPollToBe(() => tabA.isSelected(), true);
    await expect(notebook.childAt(-1)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(notebook.selectChildAt(2)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });

    const expander = expectElementKind(
      await app.getById('standard_expander'),
      'expander'
    );
    expect(await expander.getChildCount()).toBe(1);
    await expect(expander.isExpanded()).resolves.toBe(false);
    await expander.expand();
    await expectPollToBe(() => expander.isExpanded(), true);
    await expander.collapse();
    await expectPollToBe(() => expander.isExpanded(), false);
    await expander.toggle();
    await expectPollToBe(() => expander.isExpanded(), true);
    await toPass(
      async () => {
        await expectCaptureArtifact(
          await expander.capture(),
          'standard-expander-expanded'
        );
      },
      {
        message: 'standard expander expanded visual state',
        timeoutMs: fixtureTimeoutMs,
      }
    );

    const scrollbar = expectElementKind(
      await app.getById('standard_scrollbar'),
      'scrollbar'
    );
    await expect(scrollbar.value()).resolves.toBe(20);
    await scrollbar.setValue(35);
    await expectPollToBe(() => scrollbar.value(), 35);
    await toPass(
      async () => {
        await expectCaptureArtifact(
          await scrollbar.capture(),
          'standard-scrollbar'
        );
      },
      {
        message: 'standard scrollbar visual state',
        timeoutMs: fixtureTimeoutMs,
      }
    );

    const link = expectElementKind(await app.getById('standard_link'), 'link');
    await expect(link.isVisited()).resolves.toBe(false);
    await link.click();
    await expectPollToBe(() => resultLabel.text(), 'link-activated');
    await expectPollToBe(() => link.isVisited(), true);
    await expectCaptureArtifact(await link.capture(), 'standard-link-visited');

    const calendar = expectElementKind(
      await app.getById('standard_calendar'),
      'calendar'
    );
    expect(await calendar.getChildCount()).toBe(0);
    expect(calendar.getRowCount).toBeUndefined();
    await expectCaptureArtifact(await calendar.capture(), 'standard-calendar');

    const tree = expectElementKind(await app.getById('standard_tree'), 'table');
    expect(await tree.getRowCount()).toBeGreaterThan(0);
    expect(await tree.getColumnCount()).toBe(1);
    const treeCell = expectElementKind(await tree.cellAt(0, 0), 'tableCell');
    await expect(treeCell.info()).resolves.toMatchObject({ name: 'Tree A' });
    await expectCaptureArtifact(await tree.capture(), 'standard-tree');

    const toolbar = expectElementKind(
      await app.getById('standard_toolbar'),
      'toolbar'
    );
    expect(await toolbar.getChildCount()).toBe(1);
    await expectCaptureArtifact(await toolbar.capture(), 'standard-toolbar');

    const infoBar = expectElementKind(
      await app.getById('standard_info_bar'),
      'infoBar'
    );
    expect(await infoBar.getChildCount()).toBe(1);
    await expectCaptureArtifact(await infoBar.capture(), 'standard-info-bar');

    const statusBar = expectElementKind(
      await app.getById('standard_status_bar'),
      'statusBar'
    );
    expect(await statusBar.getChildCount()).toBe(0);
    await expectCaptureArtifact(
      await statusBar.capture(),
      'standard-status-bar'
    );

    const separator = expectElementKind(
      await app.getById('standard_separator'),
      'separator'
    );
    const separatorCapture = await separator.capture();
    expect(separatorCapture.bounds.width).toBeGreaterThan(0);
    expect(separatorCapture.bounds.height).toBeGreaterThan(0);
    const separatorArea = expectElement(
      await app.getById('standard_separator_area')
    );
    await expectCaptureArtifact(
      await separatorArea.capture(),
      'standard-separator'
    );
  });

  it('resolves and controls a StatusNotifier tray item', async () => {
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
    const label = expectElementKind(await app.getById('result_label'), 'label');
    await expectPollToBe(() => label.text(), 'tray-activated');

    const elementCapture = await element.capture();
    expect(elementCapture.bounds).toEqual(capture.bounds);
    expect(elementCapture.visibleBounds).toEqual(capture.visibleBounds);
    expect(elementCapture.image).toEqual(capture.image);
  });

  it('rejects when a StatusNotifier tray item is missing', async () => {
    const app = await shortLauncher.launch();

    await waitForRejectedCode(async () => {
      await app.getTrayItem({ id: 'missing-gestament-fixture' });
    }, 'ELEMENT_NOT_FOUND');
  });

  it('reports stale element when a held tray item is used after app close', async () => {
    const app = await launcher.launch(['--status-notifier-item']);
    const trayItem = await app.getTrayItem({ id: 'gestament-fixture' });

    await app.release();

    await waitForRejectedCode(async () => {
      await trayItem.metadata();
    }, 'STALE_ELEMENT');
  });
});
