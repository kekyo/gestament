// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import { shouldUseSemanticBoundsFallback } from '../src/element';
import type { GtkCaptureBounds } from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

const bounds = (
  x: number,
  y: number,
  width: number,
  height: number
): GtkCaptureBounds => ({
  height,
  width,
  x,
  y,
});

const targetWindow = {
  bounds: bounds(100, 80, 640, 480),
  title: 'Muon Probe File Dialog',
  windowId: '0x1200007',
};

describe.concurrent('X11 semantic bounds fallback', () => {
  it('rejects unrelated Chromium descendants for X11-only dialogs', () => {
    expect(
      shouldUseSemanticBoundsFallback(targetWindow, {
        bounds: bounds(100, 80, 640, 480),
        name: 'data:text/html,<a>Muon Probe</a>',
        roleName: 'link',
        x11WindowId: null,
      })
    ).toBe(false);
  });

  it('rejects same-process frames when title and bounds do not identify the X11 window', () => {
    expect(
      shouldUseSemanticBoundsFallback(targetWindow, {
        bounds: bounds(0, 0, 1280, 720),
        name: 'Muon Test Page',
        roleName: 'frame',
        x11WindowId: null,
      })
    ).toBe(false);
  });

  it('accepts semantic windows tied to the same X11 window', () => {
    expect(
      shouldUseSemanticBoundsFallback(targetWindow, {
        bounds: bounds(100, 80, 640, 480),
        name: 'Different translated title',
        roleName: 'dialog',
        x11WindowId: '0x1200007',
      })
    ).toBe(true);
  });

  it('accepts semantic windows with matching title and overlapping bounds', () => {
    expect(
      shouldUseSemanticBoundsFallback(targetWindow, {
        bounds: bounds(102, 82, 636, 476),
        name: 'Muon Probe File Dialog',
        roleName: 'frame',
        x11WindowId: null,
      })
    ).toBe(true);
  });

  it('accepts GTK file chooser roles with matching title and overlapping bounds', () => {
    expect(
      shouldUseSemanticBoundsFallback(targetWindow, {
        bounds: bounds(100, 80, 640, 480),
        name: 'Muon Probe File Dialog',
        roleName: 'file chooser',
        x11WindowId: null,
      })
    ).toBe(true);
  });
});
