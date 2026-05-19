// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeNativeError } from './errors';
import { version as packageVersion } from './generated/packageMetadata';
import type { GtkAutomationError } from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface NativeInfo {
  readonly version: string;
  readonly arch: string;
  readonly gtkBackend: GtkBackend;
  readonly napiVersion: number;
}

export interface NativeCaptureBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeCapture {
  readonly image: Buffer;
  readonly bounds: NativeCaptureBounds;
  readonly visibleBounds: NativeCaptureBounds;
  readonly clipped: boolean;
}

export interface NativeElementInfo {
  readonly roleName: string;
  readonly localizedRoleName: string;
  readonly accessibleId: string;
  readonly name: string;
  readonly description: string;
  readonly interfaces: string[];
  readonly states: string[];
}

/** AT-SPI Value metadata returned by the native layer. */
export interface NativeValueInfo {
  /** Current numeric value. */
  readonly value: number;

  /** Minimum accepted numeric value. */
  readonly minimum: number;

  /** Maximum accepted numeric value. */
  readonly maximum: number;

  /** Minimum increment used by step-based controls. */
  readonly minimumIncrement: number;

  /** Text representation reported by AT-SPI, when available. */
  readonly text: string;
}

/** Point returned by the native layer. */
export interface NativeImagePoint {
  /** Horizontal pixel coordinate. */
  readonly x: number;

  /** Vertical pixel coordinate. */
  readonly y: number;
}

/** Image size returned by the native layer. */
export interface NativeImageSize {
  /** Image width in physical pixels. */
  readonly width: number;

  /** Image height in physical pixels. */
  readonly height: number;
}

/** AT-SPI Image metadata returned by the native layer. */
export interface NativeImageInfo {
  /** Text description reported by AT-SPI. */
  readonly description: string;

  /** Image locale reported by AT-SPI. */
  readonly locale: string;

  /** Image position reported by AT-SPI. */
  readonly position: NativeImagePoint;

  /** Image size reported by AT-SPI. */
  readonly size: NativeImageSize;

  /** Screen-relative image bounds reported by AT-SPI. */
  readonly bounds: NativeCaptureBounds;
}

/** Opaque native element handle backed by an AT-SPI accessible proxy. */
export type NativeElementHandle = object;

/** AT-SPI readiness state reported by the native layer. */
export type NativeAtspiReadiness =
  | 'ready'
  | 'missing-bus-name'
  | 'missing-root'
  | 'missing-cache';

/** StatusNotifier tray item metadata reported by the native layer. */
export interface NativeTrayItem {
  readonly busName: string;
  readonly objectPath: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly iconName: string;
  readonly accessibleId: string;
}

interface NativeAddon {
  readonly findById: (
    processId: number,
    id: string
  ) => NativeElementHandle | undefined;
  readonly processAtspiReadiness: (processId: number) => NativeAtspiReadiness;
  readonly findAnyById: (id: string) => NativeElementHandle | undefined;
  readonly setTextById: (processId: number, id: string, text: string) => void;
  readonly clickById: (processId: number, id: string) => void;
  readonly textById: (processId: number, id: string) => string;
  readonly captureById: (processId: number, id: string) => NativeCapture;
  readonly windowCount: (processId: number) => number;
  readonly windowAt: (
    processId: number,
    index: number
  ) => NativeElementHandle | undefined;
  readonly childCount: (element: NativeElementHandle) => number;
  readonly childAt: (
    element: NativeElementHandle,
    index: number
  ) => NativeElementHandle | undefined;
  readonly selectedChildCount: (element: NativeElementHandle) => number;
  readonly selectedChildAt: (
    element: NativeElementHandle,
    index: number
  ) => NativeElementHandle | undefined;
  readonly isChildSelected: (
    element: NativeElementHandle,
    index: number
  ) => boolean;
  readonly selectChildAt: (element: NativeElementHandle, index: number) => void;
  readonly deselectChildAt: (
    element: NativeElementHandle,
    index: number
  ) => void;
  readonly selectAllChildren: (element: NativeElementHandle) => void;
  readonly clearSelection: (element: NativeElementHandle) => void;
  readonly tableRowCount: (element: NativeElementHandle) => number;
  readonly tableColumnCount: (element: NativeElementHandle) => number;
  readonly tableCellAt: (
    element: NativeElementHandle,
    row: number,
    column: number
  ) => NativeElementHandle | undefined;
  readonly tableSelectedRows: (element: NativeElementHandle) => number[];
  readonly tableSelectedColumns: (element: NativeElementHandle) => number[];
  readonly tableIsRowSelected: (
    element: NativeElementHandle,
    row: number
  ) => boolean;
  readonly tableIsColumnSelected: (
    element: NativeElementHandle,
    column: number
  ) => boolean;
  readonly tableIsCellSelected: (
    element: NativeElementHandle,
    row: number,
    column: number
  ) => boolean;
  readonly tableSelectRow: (element: NativeElementHandle, row: number) => void;
  readonly tableDeselectRow: (
    element: NativeElementHandle,
    row: number
  ) => void;
  readonly tableSelectColumn: (
    element: NativeElementHandle,
    column: number
  ) => void;
  readonly tableDeselectColumn: (
    element: NativeElementHandle,
    column: number
  ) => void;
  readonly setText: (element: NativeElementHandle, text: string) => void;
  readonly click: (element: NativeElementHandle) => void;
  readonly text: (element: NativeElementHandle) => string;
  readonly valueInfo: (element: NativeElementHandle) => NativeValueInfo;
  readonly imageInfo: (element: NativeElementHandle) => NativeImageInfo;
  readonly setValue: (element: NativeElementHandle, value: number) => void;
  readonly capture: (element: NativeElementHandle) => NativeCapture;
  readonly captureScreen: () => NativeCapture;
  readonly captureBounds: (
    x: number,
    y: number,
    width: number,
    height: number
  ) => NativeCapture;
  readonly mappedX11WindowCount: () => number;
  readonly elementInfo: (element: NativeElementHandle) => NativeElementInfo;
  readonly trayItems: (processId: number) => NativeTrayItem[];
  readonly runTrayHost: () => void;
  readonly nativeInfo: () => NativeInfo;
}

type GtkBackend = 'gtk3' | 'gtk4';
type GtkBackendSelection = GtkBackend | 'auto';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let loadedAddon: NativeAddon | undefined;

const createNativeLoadError = (message: string): GtkAutomationError => {
  const loadError = new Error(message) as GtkAutomationError;
  Object.defineProperty(loadError, 'code', {
    enumerable: true,
    value: 'NATIVE_LOAD_FAILED',
  });
  return loadError;
};

const selectedGtkBackend = (): GtkBackendSelection => {
  const value = process.env.GESTAMENT_GTK_BACKEND;
  if (value === undefined || value.length === 0) {
    return 'gtk3';
  }
  if (value === 'gtk3' || value === 'gtk4' || value === 'auto') {
    return value;
  }
  throw createNativeLoadError(
    `Unsupported GESTAMENT_GTK_BACKEND: ${value}. Expected gtk3, gtk4, or auto.`
  );
};

const candidateGtkBackends = (): readonly GtkBackend[] => {
  const selected = selectedGtkBackend();
  return selected === 'auto' ? ['gtk3', 'gtk4'] : [selected];
};

const prebuildDirectory = (): string => {
  if (process.platform !== 'linux') {
    throw createNativeLoadError(
      `Unsupported platform for gestament native prebuilds: ${process.platform}.`
    );
  }

  switch (process.arch) {
    case 'x64':
      return 'linux-x64';
    case 'ia32':
      return 'linux-ia32';
    case 'arm64':
      return 'linux-arm64';
    case 'arm':
      return 'linux-arm';
    case 'riscv64':
      return 'linux-riscv64';
    default:
      throw createNativeLoadError(
        `Unsupported architecture for gestament native prebuilds: ${process.arch}.`
      );
  }
};

const prebuildFile = (): string =>
  process.arch === 'arm'
    ? 'node.napi.armv7.glibc.node'
    : 'node.napi.glibc.node';

const prebuildPath = (backend: GtkBackend): string =>
  resolve(
    packageRoot,
    'prebuilds',
    prebuildDirectory(),
    backend,
    prebuildFile()
  );

const loadNativePrebuild = (backend: GtkBackend): NativeAddon => {
  const path = prebuildPath(backend);
  if (!existsSync(path)) {
    throw new Error(`Missing ${backend} native prebuild: ${path}`);
  }
  return require(path) as NativeAddon;
};

const loadNativeAddon = (): NativeAddon => {
  if (loadedAddon !== undefined) {
    return loadedAddon;
  }

  const errors: string[] = [];
  for (const backend of candidateGtkBackends()) {
    try {
      const addon = loadNativePrebuild(backend);
      const nativeInfo = addon.nativeInfo();
      if (nativeInfo.version !== packageVersion) {
        throw new Error(
          `gestament native prebuild version mismatch: native=${nativeInfo.version}, package=${packageVersion}`
        );
      }
      if (nativeInfo.gtkBackend !== backend) {
        throw new Error(
          `gestament native prebuild backend mismatch: native=${nativeInfo.gtkBackend}, requested=${backend}`
        );
      }
      loadedAddon = addon;
      return loadedAddon;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      errors.push(`${backend}: ${message}`);
    }
  }

  throw createNativeLoadError(
    `Failed to load a compatible gestament native prebuild from ${packageRoot} ` +
      `(GESTAMENT_GTK_BACKEND=${selectedGtkBackend()}). Ensure this package ` +
      'includes prebuilds for the current Linux/glibc architecture and selected ' +
      'GTK backend, and that runtime libraries such as libatspi, glib, gio, ' +
      `GTK, X11, and dbus are installed. Original errors: ${errors.join(' | ')}`
  );
};

const callNative = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    throw normalizeNativeError(error);
  }
};

/////////////////////////////////////////////////////////////////////////////////////////

/** Resolves an accessible id to a native element when it exists. */
export const nativeFindById = (
  processId: number,
  id: string
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().findById(processId, id));

/** Checks whether a GTK process has completed AT-SPI root/cache registration. */
export const nativeProcessAtspiReadiness = (
  processId: number
): NativeAtspiReadiness =>
  callNative(() => loadNativeAddon().processAtspiReadiness(processId));

/** Resolves an accessible id to a native element across all exposed processes. */
export const nativeFindAnyById = (
  id: string
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().findAnyById(id));

/** Sets text contents on the accessible with the given id. */
export const nativeSetTextById = (
  processId: number,
  id: string,
  text: string
): void => {
  callNative(() => loadNativeAddon().setTextById(processId, id, text));
};

/** Executes the first action on the accessible with the given id. */
export const nativeClickById = (processId: number, id: string): void => {
  callNative(() => loadNativeAddon().clickById(processId, id));
};

/** Reads text from the accessible with the given id. */
export const nativeTextById = (processId: number, id: string): string =>
  callNative(() => loadNativeAddon().textById(processId, id));

/** Captures real screen pixels for the accessible with the given id. */
export const nativeCaptureById = (
  processId: number,
  id: string
): NativeCapture =>
  callNative(() => loadNativeAddon().captureById(processId, id));

/** Counts top-level windows hosted by the process. */
export const nativeWindowCount = (processId: number): number =>
  callNative(() => loadNativeAddon().windowCount(processId));

/** Resolves a top-level window index to an element handle when it exists. */
export const nativeWindowAt = (
  processId: number,
  index: number
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().windowAt(processId, index));

/** Counts direct children for an element handle. */
export const nativeChildCount = (element: NativeElementHandle): number =>
  callNative(() => loadNativeAddon().childCount(element));

/** Resolves a direct child index to an element handle when it exists. */
export const nativeChildAt = (
  element: NativeElementHandle,
  index: number
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().childAt(element, index));

/** Counts selected children for a selectable element handle. */
export const nativeSelectedChildCount = (
  element: NativeElementHandle
): number => callNative(() => loadNativeAddon().selectedChildCount(element));

/** Resolves a selected child index to an element handle when it exists. */
export const nativeSelectedChildAt = (
  element: NativeElementHandle,
  index: number
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().selectedChildAt(element, index));

/** Reads whether a direct child is selected. */
export const nativeIsChildSelected = (
  element: NativeElementHandle,
  index: number
): boolean =>
  callNative(() => loadNativeAddon().isChildSelected(element, index));

/** Selects a direct child for a selectable element handle. */
export const nativeSelectChildAt = (
  element: NativeElementHandle,
  index: number
): void => {
  callNative(() => loadNativeAddon().selectChildAt(element, index));
};

/** Deselects a direct child for a selectable element handle. */
export const nativeDeselectChildAt = (
  element: NativeElementHandle,
  index: number
): void => {
  callNative(() => loadNativeAddon().deselectChildAt(element, index));
};

/** Selects all children for a selectable element handle. */
export const nativeSelectAllChildren = (element: NativeElementHandle): void => {
  callNative(() => loadNativeAddon().selectAllChildren(element));
};

/** Clears child selection for a selectable element handle. */
export const nativeClearSelection = (element: NativeElementHandle): void => {
  callNative(() => loadNativeAddon().clearSelection(element));
};

/** Counts table rows for a table element handle. */
export const nativeTableRowCount = (element: NativeElementHandle): number =>
  callNative(() => loadNativeAddon().tableRowCount(element));

/** Counts table columns for a table element handle. */
export const nativeTableColumnCount = (element: NativeElementHandle): number =>
  callNative(() => loadNativeAddon().tableColumnCount(element));

/** Resolves a table cell element handle by row and column when it exists. */
export const nativeTableCellAt = (
  element: NativeElementHandle,
  row: number,
  column: number
): NativeElementHandle | undefined =>
  callNative(() => loadNativeAddon().tableCellAt(element, row, column));

/** Reads selected table row indexes. */
export const nativeTableSelectedRows = (
  element: NativeElementHandle
): number[] => callNative(() => loadNativeAddon().tableSelectedRows(element));

/** Reads selected table column indexes. */
export const nativeTableSelectedColumns = (
  element: NativeElementHandle
): number[] =>
  callNative(() => loadNativeAddon().tableSelectedColumns(element));

/** Reads whether a table row is selected. */
export const nativeTableIsRowSelected = (
  element: NativeElementHandle,
  row: number
): boolean =>
  callNative(() => loadNativeAddon().tableIsRowSelected(element, row));

/** Reads whether a table column is selected. */
export const nativeTableIsColumnSelected = (
  element: NativeElementHandle,
  column: number
): boolean =>
  callNative(() => loadNativeAddon().tableIsColumnSelected(element, column));

/** Reads whether a table cell is selected. */
export const nativeTableIsCellSelected = (
  element: NativeElementHandle,
  row: number,
  column: number
): boolean =>
  callNative(() => loadNativeAddon().tableIsCellSelected(element, row, column));

/** Selects a table row. */
export const nativeTableSelectRow = (
  element: NativeElementHandle,
  row: number
): void => {
  callNative(() => loadNativeAddon().tableSelectRow(element, row));
};

/** Deselects a table row. */
export const nativeTableDeselectRow = (
  element: NativeElementHandle,
  row: number
): void => {
  callNative(() => loadNativeAddon().tableDeselectRow(element, row));
};

/** Selects a table column. */
export const nativeTableSelectColumn = (
  element: NativeElementHandle,
  column: number
): void => {
  callNative(() => loadNativeAddon().tableSelectColumn(element, column));
};

/** Deselects a table column. */
export const nativeTableDeselectColumn = (
  element: NativeElementHandle,
  column: number
): void => {
  callNative(() => loadNativeAddon().tableDeselectColumn(element, column));
};

/** Sets text contents on the accessible resolved by an element handle. */
export const nativeSetText = (
  element: NativeElementHandle,
  text: string
): void => {
  callNative(() => loadNativeAddon().setText(element, text));
};

/** Executes the first action on the accessible resolved by an element handle. */
export const nativeClick = (element: NativeElementHandle): void => {
  callNative(() => loadNativeAddon().click(element));
};

/** Reads text from the accessible resolved by an element handle. */
export const nativeText = (element: NativeElementHandle): string =>
  callNative(() => loadNativeAddon().text(element));

/** Reads value metadata from the accessible resolved by an element handle. */
export const nativeValueInfo = (
  element: NativeElementHandle
): NativeValueInfo => callNative(() => loadNativeAddon().valueInfo(element));

/** Reads image metadata from the accessible resolved by an element handle. */
export const nativeImageInfo = (
  element: NativeElementHandle
): NativeImageInfo => callNative(() => loadNativeAddon().imageInfo(element));

/** Sets a numeric value on the accessible resolved by an element handle. */
export const nativeSetValue = (
  element: NativeElementHandle,
  value: number
): void => {
  callNative(() => loadNativeAddon().setValue(element, value));
};

/** Captures real screen pixels for the accessible resolved by an element handle. */
export const nativeCapture = (element: NativeElementHandle): NativeCapture =>
  callNative(() => loadNativeAddon().capture(element));

/** Captures the full X11 root window currently addressed by DISPLAY. */
export const nativeCaptureScreen = (): NativeCapture =>
  callNative(() => loadNativeAddon().captureScreen());

/** Captures real screen pixels for explicit screen-relative bounds. */
export const nativeCaptureBounds = (
  bounds: NativeCaptureBounds
): NativeCapture =>
  callNative(() =>
    loadNativeAddon().captureBounds(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height
    )
  );

/** Counts mapped top-level X11 windows currently addressed by DISPLAY. */
export const nativeMappedX11WindowCount = (): number =>
  callNative(() => loadNativeAddon().mappedX11WindowCount());

/** Reads AT-SPI metadata for the accessible resolved by an element handle. */
export const nativeElementInfo = (
  element: NativeElementHandle
): NativeElementInfo =>
  callNative(() => loadNativeAddon().elementInfo(element));

/** Lists StatusNotifier tray items owned by the process. */
export const nativeTrayItems = (processId: number): NativeTrayItem[] =>
  callNative(() => loadNativeAddon().trayItems(processId));

/** Runs the test tray host until the process is terminated. */
export const nativeRunTrayHost = (): void => {
  callNative(() => loadNativeAddon().runTrayHost());
};
