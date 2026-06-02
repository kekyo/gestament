// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createGtkAppLauncher } from '../src/launchGtkApp';
import type { GtkApp, GtkWidgetElement, GtkWindowElement } from '../src/types';
import {
  fixtureWindowDiscoveryTimeoutMs as windowDiscoveryTimeoutMs,
  visualE2eTestTimeoutMs,
} from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const testBackend = process.env.GESTAMENT_TEST_BACKEND;
const describeGtk3 = testBackend === 'gtk3' ? describe : describe.skip;
const probeSourceDirectory = fileURLToPath(
  new URL('../fixtures/gtk3-window-probes', import.meta.url)
);
const probeBuildDirectory = fileURLToPath(
  new URL('../.build/gtk3-window-probes', import.meta.url)
);

let probesBuilt = false;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const ensureProbesBuilt = (): void => {
  if (probesBuilt) {
    return;
  }

  execFileSync(
    'make',
    ['-j', '-C', probeSourceDirectory, `OUT_DIR=${probeBuildDirectory}`],
    { stdio: 'inherit', timeout: visualE2eTestTimeoutMs }
  );
  probesBuilt = true;
};

const waitForWindowCount = async (
  app: GtkApp,
  expectedCount: number
): Promise<void> => {
  const startedAt = Date.now();
  let lastCount = 0;

  while (Date.now() - startedAt <= windowDiscoveryTimeoutMs) {
    lastCount = await app.getWindowCount();
    if (lastCount === expectedCount) {
      return;
    }
    await delay(50);
  }

  expect(lastCount).toBe(expectedCount);
};

const expectWindow = (
  element: GtkWidgetElement | undefined
): GtkWindowElement => {
  expect(element).toBeDefined();
  expect(element?.kind).toBe('window');
  return element as GtkWindowElement;
};

const expectElement = (
  element: GtkWidgetElement | undefined
): GtkWidgetElement => {
  expect(element).toBeDefined();
  return element as GtkWidgetElement;
};

const withProbeApp = async (
  probeName: string,
  args: readonly string[],
  body: (app: GtkApp) => Promise<void>
): Promise<void> => {
  ensureProbesBuilt();
  const launcher = createGtkAppLauncher({
    appPath: join(probeBuildDirectory, probeName),
    timeoutMs: visualE2eTestTimeoutMs,
    xvfbScreen: '900x700x24',
    xvfbTrayHost: false,
  });
  const app = await launcher.launch(args);
  try {
    await body(app);
  } finally {
    await app.release();
    await launcher.release();
  }
};

/////////////////////////////////////////////////////////////////////////////////////////

describeGtk3.concurrent('native window fusion e2e', () => {
  it(
    'deduplicates same-title AT-SPI and X11 top-level windows by bounds',
    async () => {
      await withProbeApp('same-title-probe', [], async (app) => {
        await waitForWindowCount(app, 2);
        expect(await app.getWindowCount()).toBe(2);

        const windows = [
          expectWindow(await app.windowAt(0)),
          expectWindow(await app.windowAt(1)),
        ];
        const x11Infos = await Promise.all(
          windows.map((window) => window.x11Info())
        );
        const debugDiagnostics = await Promise.all(
          windows.map((window) => window.debugDiagnostics())
        );
        const bounds = await Promise.all(
          windows.map((window) => window.bounds())
        );

        expect(new Set(x11Infos.map((info) => info.windowId)).size).toBe(2);
        expect(bounds.map((item) => item.width).sort((a, b) => a - b)).toEqual([
          220, 260,
        ]);
        expect(
          debugDiagnostics.map((diagnostics) => diagnostics.seenBy)
        ).toEqual([
          ['at-spi', 'x11'],
          ['at-spi', 'x11'],
        ]);
      });
    },
    visualE2eTestTimeoutMs
  );

  it(
    'lists parentless GTK file chooser dialogs as X11-only windows',
    async () => {
      await withProbeApp('file-dialog-probe', [], async (app) => {
        await waitForWindowCount(app, 1);

        const dialog = expectWindow(await app.windowAt(0));
        await expect(dialog.x11Info()).resolves.toMatchObject({
          title: 'Gestament Merge Probe File Dialog',
        });
        await expect(dialog.debugDiagnostics()).resolves.toMatchObject({
          matchedBy: 'x11-only',
          seenBy: ['x11'],
        });
      });
    },
    visualE2eTestTimeoutMs
  );

  it(
    'traverses direct X11 children for X11-only windows',
    async () => {
      await withProbeApp('file-dialog-probe', [], async (app) => {
        await waitForWindowCount(app, 1);

        const dialog = expectWindow(await app.windowAt(0));
        const childCount = await dialog.getChildCount();
        expect(childCount).toBeGreaterThan(0);

        const child = await dialog.childAt(0);
        expect(child).toBeDefined();

        const dialogBounds = await dialog.bounds();
        const childCapture = await expectElement(child).capture();
        expect(childCapture.bounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
        expect(childCapture.bounds.y).toBeGreaterThanOrEqual(dialogBounds.y);
        expect(
          childCapture.bounds.x + childCapture.bounds.width
        ).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
        expect(
          childCapture.bounds.y + childCapture.bounds.height
        ).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
      });
    },
    visualE2eTestTimeoutMs
  );

  it(
    'discovers windows and accessible ids from child processes',
    async () => {
      await withProbeApp('child-process-probe', [], async (app) => {
        await waitForWindowCount(app, 1);

        const window = expectWindow(await app.windowAt(0));
        await expect(window.info()).resolves.toMatchObject({
          name: 'Gestament Child Process Window',
        });

        const button = await app.getById('child_process_button');
        expect(button?.kind).toBe('button');
      });
    },
    visualE2eTestTimeoutMs
  );

  it(
    'keeps transient GTK file chooser dialogs separate from their parent',
    async () => {
      await withProbeApp('file-dialog-probe', ['--parent'], async (app) => {
        await waitForWindowCount(app, 2);

        const windows = [
          expectWindow(await app.windowAt(0)),
          expectWindow(await app.windowAt(1)),
        ];
        const rows = await Promise.all(
          windows.map(async (window) => ({
            debugDiagnostics: await window.debugDiagnostics(),
            x11Info: await window.x11Info(),
          }))
        );

        const parent = rows.find(
          (row) => row.x11Info.title === 'Gestament Merge Probe Parent'
        );
        const dialog = rows.find(
          (row) => row.x11Info.title === 'Gestament Merge Probe File Dialog'
        );

        expect(parent?.debugDiagnostics.seenBy).toEqual(['at-spi', 'x11']);
        expect(dialog?.debugDiagnostics).toMatchObject({
          matchedBy: 'x11-only',
          seenBy: ['x11'],
        });
        expect(parent?.x11Info.windowId).not.toBe(dialog?.x11Info.windowId);
      });
    },
    visualE2eTestTimeoutMs
  );
});
