// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import {
  mergeNativeWindowSnapshots,
  type AtspiWindowSnapshot,
  type X11WindowSnapshot,
} from '../src/windowDiscovery';
import type {
  GtkCaptureBounds,
  GtkWindowBackend,
  GtkWindowBackendStatus,
} from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

const bounds = (
  x: number,
  y: number,
  width: number,
  height: number
): GtkCaptureBounds => ({
  x,
  y,
  width,
  height,
});

const status = (
  backend: GtkWindowBackend,
  available: boolean,
  windowCount: number | null
): GtkWindowBackendStatus => ({
  backend,
  available,
  windowCount,
  message: available ? null : `${backend} unavailable`,
});

const statuses = (
  atspiAvailable = true,
  x11Available = true
): readonly GtkWindowBackendStatus[] => [
  status('at-spi', atspiAvailable, atspiAvailable ? 1 : null),
  status('x11', x11Available, x11Available ? 1 : null),
];

const atspiWindow = (
  overrides: Partial<AtspiWindowSnapshot> = {}
): AtspiWindowSnapshot => ({
  source: 'at-spi',
  handle: {},
  index: 0,
  processId: 1200,
  roleName: 'dialog',
  name: 'Muon Gestament Probe File Dialog',
  accessibleId: 'probe_dialog',
  bounds: bounds(10, 20, 300, 200),
  x11WindowId: null,
  ...overrides,
});

const x11Window = (
  overrides: Partial<X11WindowSnapshot> = {}
): X11WindowSnapshot => ({
  source: 'x11',
  windowId: '0x2200011',
  title: 'Muon Gestament Probe File Dialog',
  className: 'GtkFileChooserDialog',
  instanceName: 'muon',
  transientFor: null,
  processId: 1200,
  bounds: bounds(12, 22, 300, 200),
  normalHints: {
    baseWidth: 0,
    baseHeight: 0,
    minWidth: 0,
    minHeight: 0,
    widthIncrement: 0,
    heightIncrement: 0,
  },
  hasNormalHints: false,
  stackingOrder: 3,
  active: false,
  ...overrides,
});

/////////////////////////////////////////////////////////////////////////////////////////

describe.concurrent('native window discovery fusion', () => {
  it('merges AT-SPI and X11 snapshots by pid, title, and near bounds', () => {
    const [window] = mergeNativeWindowSnapshots(
      [atspiWindow()],
      [x11Window()],
      statuses()
    );

    expect(window?.debugDiagnostics.seenBy).toEqual(['at-spi', 'x11']);
    expect(window?.debugDiagnostics.matchedBy).toBe('pid-title-bounds-overlap');
    expect(window?.debugDiagnostics.mergeConfidence).toBeGreaterThan(0.9);
    expect(window?.debugDiagnostics.rawIds).toEqual({
      atspi: 'probe_dialog',
      x11: '0x2200011',
    });
    expect(window?.debugDiagnostics.discovery.atspiSnapshots).toHaveLength(1);
    expect(window?.debugDiagnostics.discovery.x11Snapshots).toHaveLength(1);
    expect(window?.debugDiagnostics.discovery.mergeCandidates).toEqual([
      expect.objectContaining({
        accepted: true,
        atspiIndex: 0,
        confidence: expect.any(Number),
        matchedBy: 'pid-title-bounds-overlap',
        rejectionReason: null,
        x11WindowId: '0x2200011',
      }),
    ]);
  });

  it('does not merge same-title windows when pid and bounds disagree', () => {
    const windows = mergeNativeWindowSnapshots(
      [atspiWindow()],
      [
        x11Window({
          processId: 1300,
          bounds: bounds(500, 500, 300, 200),
        }),
      ],
      statuses()
    );

    expect(windows).toHaveLength(2);
    expect(windows.map((window) => window.debugDiagnostics.seenBy)).toEqual([
      ['at-spi'],
      ['x11'],
    ]);
    expect(
      windows[0]?.debugDiagnostics.discovery.mergeCandidates
    ).toContainEqual(
      expect.objectContaining({
        accepted: false,
        atspiIndex: 0,
        rejectionReason: 'process-id-mismatch',
        x11WindowId: '0x2200011',
      })
    );
  });

  it('merges child-process windows only when their owner pids match', () => {
    const matching = mergeNativeWindowSnapshots(
      [
        atspiWindow({
          processId: 2101,
          name: 'Child Process Window',
        }),
      ],
      [
        x11Window({
          processId: 2101,
          title: 'Child Process Window',
        }),
      ],
      statuses()
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.debugDiagnostics.seenBy).toEqual(['at-spi', 'x11']);

    const unrelated = mergeNativeWindowSnapshots(
      [
        atspiWindow({
          processId: 2101,
          name: 'Child Process Window',
        }),
      ],
      [
        x11Window({
          processId: 2102,
          title: 'Child Process Window',
        }),
      ],
      statuses()
    );
    expect(unrelated).toHaveLength(2);
    expect(unrelated.map((window) => window.debugDiagnostics.seenBy)).toEqual([
      ['at-spi'],
      ['x11'],
    ]);
  });

  it('uses bounds to merge same-title windows when title-based X11 ids are wrong', () => {
    const windows = mergeNativeWindowSnapshots(
      [
        atspiWindow({
          accessibleId: '',
          bounds: bounds(0, 0, 220, 120),
          index: 0,
          name: 'Gestament Same Title',
          x11WindowId: '0x600007',
        }),
        atspiWindow({
          accessibleId: '',
          bounds: bounds(320, 180, 260, 160),
          index: 1,
          name: 'Gestament Same Title',
          x11WindowId: '0x600007',
        }),
      ],
      [
        x11Window({
          bounds: bounds(0, 0, 220, 120),
          stackingOrder: 4,
          title: 'Gestament Same Title',
          windowId: '0x600003',
        }),
        x11Window({
          bounds: bounds(320, 180, 260, 160),
          stackingOrder: 5,
          title: 'Gestament Same Title',
          windowId: '0x600007',
        }),
      ],
      statuses()
    );

    expect(windows).toHaveLength(2);
    expect(windows.map((window) => window.debugDiagnostics.rawIds.x11)).toEqual(
      ['0x600003', '0x600007']
    );
    expect(windows.map((window) => window.debugDiagnostics.seenBy)).toEqual([
      ['at-spi', 'x11'],
      ['at-spi', 'x11'],
    ]);
  });

  it('does not merge ambiguous same-confidence X11 candidates', () => {
    const windows = mergeNativeWindowSnapshots(
      [
        atspiWindow({
          bounds: bounds(0, 0, 220, 120),
          name: 'Ambiguous',
        }),
      ],
      [
        x11Window({
          bounds: bounds(0, 0, 220, 120),
          title: 'Ambiguous',
          windowId: '0x1',
        }),
        x11Window({
          bounds: bounds(0, 0, 220, 120),
          title: 'Ambiguous',
          windowId: '0x2',
        }),
      ],
      statuses()
    );

    expect(windows).toHaveLength(3);
    expect(windows.map((window) => window.debugDiagnostics.seenBy)).toEqual([
      ['at-spi'],
      ['x11'],
      ['x11'],
    ]);
  });

  it('keeps X11-only windows discoverable with diagnostic backend gaps', () => {
    const [window] = mergeNativeWindowSnapshots([], [x11Window()], statuses());

    expect(window?.title).toBe('Muon Gestament Probe File Dialog');
    expect(window?.debugDiagnostics.seenBy).toEqual(['x11']);
    expect(window?.debugDiagnostics.missingFrom).toEqual(['at-spi']);
    expect(window?.debugDiagnostics.matchedBy).toBe('x11-only');
  });

  it('keeps AT-SPI-only windows discoverable when X11 is unavailable', () => {
    const [window] = mergeNativeWindowSnapshots(
      [atspiWindow()],
      [],
      statuses(true, false)
    );

    expect(window?.name).toBe('Muon Gestament Probe File Dialog');
    expect(window?.debugDiagnostics.seenBy).toEqual(['at-spi']);
    expect(window?.debugDiagnostics.missingFrom).toEqual([]);
    expect(window?.debugDiagnostics.backendStatus[1]?.available).toBe(false);
  });

  it('returns no unified windows when both backends report no windows', () => {
    expect(mergeNativeWindowSnapshots([], [], statuses())).toEqual([]);
  });

  it('orders X11-only windows by stacking order after semantic windows', () => {
    const windows = mergeNativeWindowSnapshots(
      [
        atspiWindow({
          name: 'Main',
          accessibleId: 'main',
          bounds: bounds(900, 900, 320, 240),
        }),
      ],
      [
        x11Window({ windowId: '0x2', title: 'Back', stackingOrder: 1 }),
        x11Window({ windowId: '0x3', title: 'Front', stackingOrder: 4 }),
      ],
      statuses()
    );

    expect(windows.map((window) => window.title)).toEqual([
      'Main',
      'Back',
      'Front',
    ]);
  });
});
